import type { SshCredentialsDraft } from './SshCredentialsFields';
import type { SshConfiguredHostSuggestion } from './filterConfiguredSshHostSuggestions';

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

export function applyConfiguredSshHostSuggestionToDraft(
    draft: SshCredentialsDraft,
    suggestion: SshConfiguredHostSuggestion,
): SshCredentialsDraft {
    const alias = suggestion.alias.trim();
    const hostname = suggestion.hostname.trim();
    return {
        ...draft,
        host: alias || hostname,
        ...(suggestion.username ? { username: suggestion.username } : {}),
        ...(suggestion.port ? { port: String(suggestion.port) } : {}),
    };
}
