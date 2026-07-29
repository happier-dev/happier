import { readAcpConfiguredBackendV1FromMetadata } from '@happier-dev/protocol';

import type { Session } from '@/sync/domains/state/storageTypes';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

function normalizeTitle(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function resolveSessionActionDefaultBackendTitle(params: Readonly<{
    session: Session | null | undefined;
    sessionActionDefaultBackendEntryTitle?: string | null;
    fallbackTitle?: string | null;
}>): string {
    const sessionActionDefaultBackendEntryTitle = normalizeTitle(params.sessionActionDefaultBackendEntryTitle);
    if (sessionActionDefaultBackendEntryTitle) {
        return sessionActionDefaultBackendEntryTitle;
    }

    const configuredBackend = readAcpConfiguredBackendV1FromMetadata(
        params.session ? readSessionOwnerMetadataView(params.session) : null,
    );
    const configuredBackendTitle = normalizeTitle(configuredBackend?.title);
    if (configuredBackendTitle) {
        return configuredBackendTitle;
    }

    const fallbackTitle = normalizeTitle(params.fallbackTitle);
    return fallbackTitle ?? '';
}
