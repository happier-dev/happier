import { createSessionDetailsTerminalTab } from '@/components/sessions/terminal/embeddedTerminalDocking';

export function createSessionFileDetailsTab(fullPath: string) {
    const fileName = fullPath.split('/').pop() ?? fullPath;
    return {
        key: `file:${fullPath}`,
        kind: 'file' as const,
        title: fileName,
        resource: { kind: 'file' as const, path: fullPath },
    };
}

export function createSessionCommitDetailsTab(sha: string) {
    const safeSha = sha.trim().split(/\s+/)[0] ?? '';
    if (!safeSha) {
        return null;
    }
    return {
        key: `commit:${safeSha}`,
        kind: 'commit' as const,
        title: safeSha.slice(0, 7),
        resource: { kind: 'commit' as const, sha: safeSha },
    };
}

export { createSessionDetailsTerminalTab };
