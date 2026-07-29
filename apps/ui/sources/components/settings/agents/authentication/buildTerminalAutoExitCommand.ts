export function buildTerminalAutoExitCommand(command: string, platform: NodeJS.Platform | string | null | undefined): string {
    const trimmed = command.trim();
    if (!trimmed) return '';

    if (platform === 'win32') {
        return `${trimmed} & if not errorlevel 1 exit`;
    }

    return `${trimmed}; __happier_auth_rc=$?; if [ \"$__happier_auth_rc\" -eq 0 ]; then exit; fi`;
}
