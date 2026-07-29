function needsShellQuoting(value: string): boolean {
    return value.length === 0 || /[\s"'`$&|;<>()[\]{}*?!\\%^]/.test(value);
}

function quoteShellArgument(value: string, platform: NodeJS.Platform | string | null | undefined): string {
    if (platform === 'win32') {
        return `"${value.replaceAll('"', '""')}"`;
    }
    return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function formatAgentLocalAuthShellArgument(
    value: string,
    platform: NodeJS.Platform | string | null | undefined,
): string {
    return needsShellQuoting(value) ? quoteShellArgument(value, platform) : value;
}

export function resolveAgentLocalAuthBaseCommand(params: Readonly<{
    resolvedPath?: string | null;
    resolvedCommand?: string | null;
    fallbackCommand: string;
    platform?: NodeJS.Platform | string | null;
}>): string {
    const resolvedCommand = String(params.resolvedCommand ?? '').trim();
    if (resolvedCommand) return resolvedCommand;

    const resolvedPath = String(params.resolvedPath ?? '').trim();
    if (resolvedPath) {
        return formatAgentLocalAuthShellArgument(resolvedPath, params.platform);
    }

    return params.fallbackCommand.trim() || params.fallbackCommand;
}
