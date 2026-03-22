export function resolveWorkspaceDisplayNameFromPath(path: string): string {
    const normalized = String(path).replace(/[\\/]+$/, '');
    const segments = normalized.split(/[\\/]/).filter((segment) => segment.length > 0);
    const terminalSegment = segments[segments.length - 1] ?? normalized;
    return terminalSegment.length > 0 ? terminalSegment : 'workspace';
}
