import type { SshCredentialsDraft } from './SshCredentialsFields';

export function createDefaultSshCredentialsDraft(): SshCredentialsDraft {
    return {
        username: '',
        host: '',
        port: '',
        authMode: 'agent',
        identityFilePath: '',
        password: '',
    };
}

export function isSshCredentialsDraftReady(draft: SshCredentialsDraft): boolean {
    return draft.username.trim().length > 0 && draft.host.trim().length > 0;
}

export function parseSshPortNumber(portText: string): number | null {
    const trimmed = String(portText ?? '').trim();
    if (!trimmed) return null;
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) return null;
    return parsed;
}
