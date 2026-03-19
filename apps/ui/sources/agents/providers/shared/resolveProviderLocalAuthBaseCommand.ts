function needsShellQuoting(value: string): boolean {
    return /[\s"'`$&|;<>()[\]{}*?!\\]/.test(value);
}

function quoteShellArgument(value: string, platform: NodeJS.Platform | string | null | undefined): string {
    if (platform === 'win32') {
        return `"${value.replaceAll('"', '""')}"`;
    }
    return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function resolveProviderLocalAuthBaseCommand(params: Readonly<{
    resolvedPath?: string | null;
    resolvedCommand?: string | null;
    fallbackCommand: string;
    platform?: NodeJS.Platform | string | null;
}>): string {
    const resolvedCommand = String(params.resolvedCommand ?? '').trim();
    if (resolvedCommand) return resolvedCommand;

    const resolvedPath = String(params.resolvedPath ?? '').trim();
    if (resolvedPath) {
        return needsShellQuoting(resolvedPath)
            ? quoteShellArgument(resolvedPath, params.platform)
            : resolvedPath;
    }

    return params.fallbackCommand.trim() || params.fallbackCommand;
}
