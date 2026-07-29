import { describe, expect, it } from 'vitest';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { resolveSessionListRowStoreScopeKey } from '@/components/sessions/shell/row/sessionListVisibleRowStoreScopes';
import { EXTERNAL_SESSION_STATUS_DEMAND_MAX_ENTRIES_V1 } from '@happier-dev/protocol';

import { collectExternalSessionStatusDemandViewportEntries } from './collectExternalSessionStatusDemandViewportEntries';

function createFixture(size: number) {
    const items: SessionListIndexItem[] = Array.from({ length: size }, (_, index) => ({
        type: 'session',
        serverId: 'server-1',
        sessionId: `session-${index}`,
    }));
    const renderables = new Map<string, SessionListRenderableSession>();
    for (let index = 0; index < size; index += 1) {
        const rowKey = resolveSessionListRowStoreScopeKey({
            serverId: 'server-1',
            sessionId: `session-${index}`,
        });
        const renderable: SessionListRenderableSession = {
            id: `session-${index}`,
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 0,
            metadataVersion: 1,
            agentStateVersion: 1,
            metadata: {
                path: '/workspace',
                externalSessionV1: {
                    v: 1,
                    agentId: 'claude',
                    machineId: 'machine-1',
                    remoteSessionId: `remote-${index}`,
                    source: {
                        kind: 'claudeConfigDir',
                        configDir: '/tmp/claude',
                    },
                    linkedAtMs: index + 1,
                },
            },
            thinking: false,
            thinkingAt: 0,
            presence: 0,
        };
        renderables.set(rowKey, renderable);
    }
    return { items, renderables };
}

describe('collectExternalSessionStatusDemandViewportEntries', () => {
    for (const size of [100, 1_000, 10_000]) {
        it(`touches only the exact 20-row viewport for a ${size}-row list`, () => {
            const fixture = createFixture(size);
            const visibleRowKeys = new Set(
                fixture.items.slice(size - 20).map((item) => resolveSessionListRowStoreScopeKey({
                    serverId: item.type === 'session' ? item.serverId : null,
                    sessionId: item.type === 'session' ? item.sessionId : '',
                })),
            );
            let rowRenderableReads = 0;

            const entries = collectExternalSessionStatusDemandViewportEntries({
                activeServerId: 'server-1',
                renderedListItems: fixture.items,
                resolveRowRenderable: (rowKey) => {
                    rowRenderableReads += 1;
                    return fixture.renderables.get(rowKey) ?? null;
                },
                visibleRowKeys,
            });

            expect(rowRenderableReads).toBe(20);
            expect(entries).toHaveLength(20);
            expect(entries.every((entry) => entry.demand === 'visible')).toBe(true);
        });
    }

    for (const size of [100, 1_000, 10_000]) {
        it(`bounds the loaded fallback for a ${size}-row list before viewability is known`, () => {
            const fixture = createFixture(size);
            let rowRenderableReads = 0;

            const entries = collectExternalSessionStatusDemandViewportEntries({
                activeServerId: 'server-1',
                renderedListItems: fixture.items,
                resolveRowRenderable: (rowKey) => {
                    rowRenderableReads += 1;
                    return fixture.renderables.get(rowKey) ?? null;
                },
                visibleRowKeys: null,
            });

            expect(rowRenderableReads).toBeLessThanOrEqual(EXTERNAL_SESSION_STATUS_DEMAND_MAX_ENTRIES_V1);
            expect(entries).toHaveLength(Math.min(
                size,
                EXTERNAL_SESSION_STATUS_DEMAND_MAX_ENTRIES_V1,
            ));
            expect(entries.every((entry) => entry.demand === 'loaded')).toBe(true);
        });
    }
});
