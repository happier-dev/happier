export function resolveMachineAbsolutePath(input: Readonly<{ rootPath: string; requestPath?: string | null }>): string {
    const requestPath = input.requestPath ?? '';
    if (!requestPath || requestPath === '.') return input.rootPath;
    if (requestPath.startsWith('~')) return requestPath;

    const isAbsolutePosix = requestPath.startsWith('/');
    const isAbsoluteWindows = /^[a-zA-Z]:[\\/]/.test(requestPath) || requestPath.startsWith('\\\\');
    if (isAbsolutePosix || isAbsoluteWindows) return requestPath;

    const separator = input.rootPath.includes('\\') ? '\\' : '/';
    const base = input.rootPath.endsWith(separator) ? input.rootPath.slice(0, -1) : input.rootPath;
    const rel = requestPath.startsWith(separator) ? requestPath.slice(1) : requestPath;
    return `${base}${separator}${rel}`;
}
