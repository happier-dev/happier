import { resolvePathRelativeToRoot } from '@/utils/path/resolvePathRelativeToRoot';

export function resolveMachineAbsolutePath(input: Readonly<{
    rootPath: string;
    agentRootPath?: string | null;
    requestPath?: string | null;
}>): string {
    const requestPath = input.requestPath ?? '';
    if (!requestPath || requestPath === '.') return input.rootPath;
    if (requestPath.startsWith('~')) return requestPath;

    const isAbsolutePosix = requestPath.startsWith('/');
    const isAbsoluteWindows = /^[a-zA-Z]:[\\/]/.test(requestPath) || requestPath.startsWith('\\\\');
    if (isAbsolutePosix || isAbsoluteWindows) {
        const relative = input.agentRootPath
            ? resolvePathRelativeToRoot({ path: requestPath, root: input.agentRootPath })
            : null;
        if (relative === null) return requestPath;
        if (relative === '.') return input.rootPath;
        const separator = input.rootPath.includes('\\') ? '\\' : '/';
        const base = input.rootPath.endsWith(separator) ? input.rootPath.slice(0, -1) : input.rootPath;
        return `${base}${separator}${relative.replace(/[\\/]/g, separator)}`;
    }

    const separator = input.rootPath.includes('\\') ? '\\' : '/';
    const base = input.rootPath.endsWith(separator) ? input.rootPath.slice(0, -1) : input.rootPath;
    const rel = requestPath.startsWith(separator) ? requestPath.slice(1) : requestPath;
    return `${base}${separator}${rel}`;
}
