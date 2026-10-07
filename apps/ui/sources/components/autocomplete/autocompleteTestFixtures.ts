import { MetadataSchema } from '@happier-dev/session-core/state';
import { createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

/** Seed the real store with complete daemon metadata, retaining the production writers. */
export function seedAutocompleteSessions(
    sessions: Readonly<Record<string, Partial<Omit<Session, 'metadata'>> & { metadata?: unknown }>>,
): void {
    storage.setState({ sessions: Object.fromEntries(Object.entries(sessions).map(([id, session]) => [
        id,
        createSessionFixture({ serverId: 'server-a', ...session, id, metadata: MetadataSchema.parse({
            path: '/repo', host: 'autocomplete.test',
            ...(session.metadata && typeof session.metadata === 'object' ? session.metadata : {}),
        }) }),
    ])) });
}

export function seedAutocompleteSessionRows(
    rowsByServerId: Readonly<Record<string, Readonly<Record<string,
        Partial<Omit<SessionListRenderableSession, 'metadata'>> & { metadata?: unknown }
    >>>>,
): void {
    storage.setState({ sessionListRowsByServerId: Object.fromEntries(Object.entries(rowsByServerId).map(
        ([serverId, rows]) => [serverId, Object.fromEntries(Object.entries(rows).map(([id, row]) => [
            id, createSessionListRenderableSessionFixture({ ...row, id, metadata: MetadataSchema.parse({
                path: '/repo', host: 'autocomplete.test',
                ...(row.metadata && typeof row.metadata === 'object' ? row.metadata : {}),
            }) }),
        ]))],
    )) });
}
