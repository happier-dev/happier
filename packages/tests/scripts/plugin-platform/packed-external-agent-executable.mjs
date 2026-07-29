export function renderPackedExternalAgentExecutable(platform = process.platform) {
  return platform === 'win32'
    ? {
        fileName: 'packed-external-agent.cmd',
        contents: [
          '@echo off',
          'if "%~1"=="--version" echo packed-external-agent 1.0.0',
          'if "%~1"=="version" echo packed-external-agent 1.0.0',
          'if "%~1"=="-v" echo packed-external-agent 1.0.0',
          'exit /b 0',
          '',
        ].join('\r\n'),
      }
    : {
        fileName: 'packed-external-agent',
        contents: [
          '#!/bin/sh',
          'case "${1:-}" in',
          "  --version|version|-v) printf '%s\\n' 'packed-external-agent 1.0.0' ;;",
          'esac',
          'exit 0',
          '',
        ].join('\n'),
      };
}
