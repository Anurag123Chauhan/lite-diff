# lite-diff

A tiny, low-memory git diff viewer and file editor for big repos. Use it when you only need to review changes and VS Code is eating your RAM and CPU.

- Zero dependencies: one Node script plus one HTML file
- No indexing, file watching or language server, so it idles at ~0% CPU and ~60 MB RAM
- Changes view (uncommitted or whole branch vs `main`) with coloured diffs
- Lazy-loading file tree and Ctrl+P file search
- Ctrl+click go-to-definition with a configurable depth limit; resolves relative imports, tsconfig `paths`, workspace package `exports`, and barrel re-exports
- Edit + save with syntax highlighting, Ctrl+click go-to-definition while editing, and unsaved drafts kept when you navigate away
- VS Code-style change markers in the gutter (green added, blue modified, red deleted) plus an overview strip, updated live as you type, against HEAD or the branch base

## Usage

Requires Node 18+ and git.

```sh
node lite-diff.mjs [repo-path] [--depth 3] [--port 4777] [--tab] [--no-open]
```

| Option | Default | Description |
| --- | --- | --- |
| `repo-path` | current dir | Any folder inside a git repo |
| `--depth` | `3` | Max Ctrl+click hops per chain. Open a file from the sidebar or Ctrl+P to start a new chain |
| `--port` | `4777` | Tries the next ports if it's taken |
| `--tab` | off | Open a normal browser tab instead of an Edge app window |
| `--no-open` | off | Don't open a browser |

On Windows you can also run `lite-diff.cmd [repo-path] [options]`. With no repo path (for example from a desktop shortcut) it offers the last repo you used, or asks for one. Closing its console window stops the server.

> In Git Bash, use forward slashes: `node /c/path/to/lite-diff.mjs /c/path/to/repo`.

## Keys

| Key | Action |
| --- | --- |
| Ctrl+click | Go to definition of an import path or imported name |
| Alt+← | Back |
| Ctrl+P | Go to file |
| E | Edit current file |
| Ctrl+S | Save |
| R | Refresh |

## Notes

- Go-to-definition matches import/export text rather than type-checking, so it can't follow things like `obj.method`. External packages under `node_modules` are not followed on purpose.
- The server binds to `127.0.0.1` only, rejects requests with other `Host` headers, and refuses paths outside the repo.
