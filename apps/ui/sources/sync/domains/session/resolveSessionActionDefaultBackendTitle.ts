import { readAcpConfiguredBackendV1FromMetadata } from '@happier-dev/protocol';

import type { AgentId } from '@/agents/catalog/catalog';
import type { Session } from '@/sync/domains/state/storageTypes';

function normalizeTitle(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function resolveSessionActionDefaultBackendTitle(params: Readonly<{
    session: Session | null | undefined;
    agentId: AgentId;
    sessionActionDefaultBackendEntryTitle?: string | null;
    fallbackTitle?: string | null;
}>): string {
    const sessionActionDefaultBackendEntryTitle = normalizeTitle(params.sessionActionDefaultBackendEntryTitle);
    if (sessionActionDefaultBackendEntryTitle) {
        return sessionActionDefaultBackendEntryTitle;
    }

    const configuredBackend = readAcpConfiguredBackendV1FromMetadata(params.session?.metadata ?? null);
    const configuredBackendTitle = normalizeTitle(configuredBackend?.title);
    if (configuredBackendTitle) {
        return configuredBackendTitle;
    }

    const fallbackTitle = normalizeTitle(params.fallbackTitle);
    return fallbackTitle ?? '';
}
