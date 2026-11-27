import { deriveLinkFromHostedMetadata } from '@happier-dev/agents';

import type { Metadata, Session } from '@/sync/domains/state/storageTypes';

const readOnlyLinkKey = 'directSessionV1';

export function hasDerivedRetainedSessionLink(metadata: Metadata | null | undefined): boolean {
    return metadata != null && Object.getOwnPropertyDescriptor(metadata, readOnlyLinkKey)?.enumerable === false;
}

/**
 * The store presents a retained row to existing direct-session readers. Keep the
 * projected link out of spreads and JSON so ordinary metadata writes use the
 * stored shape, even when they start from this in-memory view.
 */
export function projectRetainedSessionLink<T extends Pick<Session, 'metadata' | 'cloudCopyLeftAt'>>(session: T): T {
    const metadata = session.metadata;
    if (!metadata) return session;
    const projected = hasDerivedRetainedSessionLink(metadata);
    if (session.cloudCopyLeftAt == null) {
        return projected ? { ...session, metadata: { ...metadata } } : session;
    }
    if (projected || metadata.directSessionV1 != null) return session;

    const view = { ...metadata };
    Object.defineProperty(view, readOnlyLinkKey, {
        value: deriveLinkFromHostedMetadata(metadata) ?? { v: 1 },
        enumerable: false,
    });
    return { ...session, metadata: view };
}
