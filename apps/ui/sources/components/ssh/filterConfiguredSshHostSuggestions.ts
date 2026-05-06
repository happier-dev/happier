import { parseSshTarget } from '@happier-dev/protocol';

import type { RemoteHost } from '@/sync/domains/remoteHosts/remoteHostModel';

export type SshConfiguredHostSuggestionSource = 'ssh-config' | 'known-hosts';

export type SshConfiguredHostSuggestion = Readonly<{
    id: string;
    alias: string;
    hostname: string;
    port: number | null;
    username: string | null;
    source: SshConfiguredHostSuggestionSource;
    sourcePath?: string | null;
}>;

type FilterConfiguredSshHostSuggestionsParams = Readonly<{
    suggestions: readonly SshConfiguredHostSuggestion[];
    remoteHosts: readonly RemoteHost[];
}>;

function normalizeToken(value: string | null | undefined): string {
    return String(value ?? '').trim().replace(/\.$/u, '').toLowerCase();
}

function normalizePort(port: number | null | undefined): number {
    return typeof port === 'number' && Number.isInteger(port) && port > 0 ? port : 22;
}

function usernamesCompatible(
    suggestion: SshConfiguredHostSuggestion,
    remoteHost: RemoteHost,
): boolean {
    const suggestionUsername = normalizeToken(suggestion.username);
    if (!suggestionUsername) return true;
    const parsed = parseSshTarget(remoteHost.ssh.target);
    const remoteHostUsername = normalizeToken(parsed.username);
    return !remoteHostUsername || suggestionUsername === remoteHostUsername;
}

function suggestionMatchesRemoteHost(
    suggestion: SshConfiguredHostSuggestion,
    remoteHost: RemoteHost,
): boolean {
    if (normalizePort(suggestion.port) !== normalizePort(remoteHost.ssh.port)) {
        return false;
    }
    if (!usernamesCompatible(suggestion, remoteHost)) {
        return false;
    }

    const parsed = parseSshTarget(remoteHost.ssh.target);
    const savedHostCandidates = [
        remoteHost.name,
        parsed.host,
        remoteHost.ssh.target,
    ].map(normalizeToken).filter(Boolean);
    const suggestionCandidates = [
        suggestion.alias,
        suggestion.hostname,
    ].map(normalizeToken).filter(Boolean);

    return suggestionCandidates.some((candidate) => savedHostCandidates.includes(candidate));
}

export function filterConfiguredSshHostSuggestions(
    params: FilterConfiguredSshHostSuggestionsParams,
): SshConfiguredHostSuggestion[] {
    return params.suggestions.filter((suggestion) => (
        !params.remoteHosts.some((remoteHost) => suggestionMatchesRemoteHost(suggestion, remoteHost))
    ));
}
