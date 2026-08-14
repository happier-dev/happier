@echo off
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0hstack-exec.ps1" %*
exit /b %ERRORLEVEL%
