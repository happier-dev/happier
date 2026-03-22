import { describe, expect, it } from 'vitest';

import { createTestMetadata } from './sessionMetadata';

describe('session fixtures', () => {
    it('defaults runtime session metadata to the canonical metadata helper', async () => {
        const mod = await import('./sessionFixtures');
        const { getMetadata } = mod.createSessionClientWithMetadata();

        expect(getMetadata()).toEqual(createTestMetadata());
    });

    it('creates a mock session with canonical metadata defaults', async () => {
        const mod = await import('./sessionFixtures');
        const mockSession = mod.createMockSession();

        expect(mockSession.metadata).toEqual(createTestMetadata());
    });

    it('creates plaintext session fixtures with canonical metadata defaults', async () => {
        const mod = await import('./sessionFixtures');
        const session = mod.createPlainSessionFixture();

        expect(session).toMatchObject({
            id: 'test-session-id',
            seq: 0,
            encryptionMode: 'plain',
            metadata: createTestMetadata(),
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
        });
        expect('encryptionKey' in session).toBe(false);
    });

    it('creates plaintext session fixtures with metadata overrides', async () => {
        const mod = await import('./sessionFixtures');
        const session = mod.createPlainSessionFixture({
            id: 'plain-1',
            metadata: createTestMetadata({ machineId: 'machine-1' }),
        });

        expect(session).toMatchObject({
            id: 'plain-1',
            encryptionMode: 'plain',
            metadata: createTestMetadata({ machineId: 'machine-1' }),
        });
    });

    it('creates session record fixtures with stable defaults', async () => {
        const mod = await import('./sessionFixtures');
        const row = mod.createSessionRecordFixture({ id: 'sess-1' });

        expect(row).toMatchObject({
            id: 'sess-1',
            seq: 0,
            active: false,
            activeAt: 0,
            metadata: 'metadata',
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            pendingCount: 0,
            pendingVersion: 0,
            dataEncryptionKey: null,
        });
    });

    it('creates session list response fixtures with stable pagination defaults', async () => {
        const mod = await import('./sessionFixtures');
        const row = mod.createSessionRecordFixture({ id: 'sess-1' });
        const response = mod.createSessionListResponseFixture([row]);

        expect(response).toEqual({
            sessions: [row],
            nextCursor: null,
            hasNext: false,
        });
    });

    it('creates lightweight api session clients with metadata snapshots', async () => {
        const mod = await import('./sessionFixtures');
        const session = mod.createApiSessionClientFixture({
            metadataPermissionMode: 'read-only',
        });

        expect(session.getMetadataSnapshot?.()).toEqual(
            createTestMetadata({ permissionMode: 'read-only' }),
        );
    });

    it('creates mutable api session clients with canonical metadata lifecycle helpers', async () => {
        const mod = await import('./sessionFixtures');
        const session = mod.createMutableApiSessionClientFixture({
            metadataPermissionMode: 'read-only',
        });

        expect(session.getMetadataSnapshot?.()).toEqual(
            createTestMetadata({ permissionMode: 'read-only' }),
        );

        const currentMetadata = session.__getMetadata();
        if (!currentMetadata) {
            throw new Error('Expected metadata fixture');
        }

        session.updateMetadata((current) => ({
            ...(current ?? currentMetadata),
            permissionMode: 'default',
        }));

        expect(session.__getMetadata()).toMatchObject({ permissionMode: 'default' });

        const replacement = createTestMetadata({ permissionMode: 'acceptEdits' });
        session.__setMetadata(replacement);
        expect(session.getMetadataSnapshot?.()).toEqual(replacement);
    });

    it('creates basic session clients with selective overrides', async () => {
        const mod = await import('./sessionFixtures');
        const seen: string[] = [];
        const session = mod.createBasicSessionClientWithOverrides({
            sendAgentMessage: (_provider, body) => {
                seen.push(String((body as { type?: string })?.type ?? 'unknown'));
            },
        });

        session.sendAgentMessage('provider', { type: 'thinking' } as never);

        expect(seen).toEqual(['thinking']);
    });
});
