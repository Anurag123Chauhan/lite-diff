@echo off
rem Usage: lite-diff [repo-path] [--depth N] [--tab]
rem With no repo-path (e.g. from the desktop shortcut) it offers the last repo, or asks for one.
setlocal
set "LAST=%~dp0.last-repo"
set "REPO=%~1"
if "%REPO:~0,1%"=="-" set "REPO="
if not "%REPO%"=="" goto run

if exist "%LAST%" set /p REPO=<"%LAST%"
if "%REPO%"=="" goto ask
set "PICK="
set /p "PICK=Repo [%REPO%] - Enter to reuse, or type another path: "
if not "%PICK%"=="" set "REPO=%PICK%"
goto run

:ask
set /p "REPO=Path to a git repo: "

:run
if "%REPO%"=="" exit /b 1
set "REPO=%REPO:"=%"
> "%LAST%" echo %REPO%
title lite-diff - %REPO%
echo Close this window to stop lite-diff.
rem lite-diff.mjs takes the first positional arg as the repo, so a repeated repo-path in %* is ignored.
node "%~dp0lite-diff.mjs" "%REPO%" %*
if errorlevel 1 pause
