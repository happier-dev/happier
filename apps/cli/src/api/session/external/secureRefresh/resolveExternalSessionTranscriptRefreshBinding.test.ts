import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
    loadLinkedExternalSessionMock,
    readCredentialsMock,
    readStoredCredentialsMock,
    resolveExternalSessionObservationLinkInputMock,
} = vi.hoisted(() => ({
    loadLinkedExternalSessionMock: vi.fn(),
    readCredentialsMock: vi.fn(),
    readStoredCredentialsMock: vi.fn(),
    resolveExternalSessionObservationLinkInputMock: vi.fn(),
}));

vi.mock('@/api/session/external/takeover/loadLinkedExternalSession', () => ({
    loadLinkedExternalSession: loadLinkedExternalSessionMock,
}));
vi.mock('@/api/session/external/leases/resolveExternalSessionObservationLinkInput', () => ({
    resolveExternalSessionObservationLinkInput:
        resolveExternalSessionObservationLinkInputMock,
}));
vi.mock('@/persistence', () => ({
    readCredentials: readCredentialsMock,
    readStoredCredentials: readStoredCredentialsMock,
}));

import { readOrCreateDeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import {
    deriveExternalSessionTranscriptRefreshCursorIdentity,
    resolveExternalSessionTranscriptRefreshBinding,
} from './resolveExternalSessionTranscriptRefreshBinding';

const authority = {
    machineId: 'machine-1',
    sessionId: 'session-1',
    link: {
        generation: 'link-generation-1',
        remoteSessionId: 'remote-session-1',
    },
    source: {
        qualifiedIdentity: {
            v: 1 as const,
            agent: {
                pluginId: 'happier.codex',
                localId: 'codex',
            },
            source: {
                kind: 'codexHome',
                contractVersion: 1 as const,
            },
        },
        generation: 'source-generation-1',
    },
    contributionGeneration: 'contribution-generation-1',
};

describe('secure refresh cursor binding identity', () => {
    let home: string;

    beforeEach(async () => {
        vi.clearAllMocks();
        home = await mkdtemp(join(tmpdir(), 'happier-external-refresh-binding-'));
    });

    afterEach(async () => {
        await rm(home, { recursive: true, force: true });
    });

    it('is restart-stable, non-reversible on the wire, and bound to the full cursor and authority tuple', async () => {
        const path = join(home, 'device-key.json');
        const firstStorage = await readOrCreateDeviceLocalSecretStorage({
            path,
            randomBytes: (length) => new Uint8Array(length).fill(7),
        });
        const restartedStorage = await readOrCreateDeviceLocalSecretStorage({ path });
        const cursor =
            'happier_external_cursor_v1:eyJuYXRpdmVDdXJzb3IiOiIvcHJpdmF0ZS9hZ2VudC90cmFuc2NyaXB0Lmpzb25sOjIwNDgifQ';
        const identity = deriveExternalSessionTranscriptRefreshCursorIdentity({
            deviceLocalSecretStorage: firstStorage,
            cursor,
            authority,
        });

        expect(identity).toMatch(/^external_session_cursor_binding_v1:[0-9a-f]{64}$/);
        expect(identity).toBe(deriveExternalSessionTranscriptRefreshCursorIdentity({
            deviceLocalSecretStorage: restartedStorage,
            cursor,
            authority,
        }));
        expect(identity).not.toContain(cursor);
        expect(identity).not.toContain('/private/agent/transcript.jsonl:2048');
        expect(deriveExternalSessionTranscriptRefreshCursorIdentity({
            deviceLocalSecretStorage: firstStorage,
            cursor: `${cursor}x`,
            authority,
        })).not.toBe(identity);
        expect(deriveExternalSessionTranscriptRefreshCursorIdentity({
            deviceLocalSecretStorage: firstStorage,
            cursor,
            authority: {
                ...authority,
                link: {
                    ...authority.link,
                    generation: 'link-generation-2',
                },
            },
        })).not.toBe(identity);
    });

    it('resolves a token-only plain Session binding without reading Account E2EE material', async () => {
        const deviceLocalSecretStorage = await readOrCreateDeviceLocalSecretStorage({
            path: join(home, 'device-key.json'),
            randomBytes: (length) => new Uint8Array(length).fill(8),
        });
        readStoredCredentialsMock.mockResolvedValue({
            token: 'plain-token',
            encryption: null,
        });
        loadLinkedExternalSessionMock.mockResolvedValue({
            ok: true,
            session: {
                machineId: authority.machineId,
                remoteSessionId: authority.link.remoteSessionId,
                linkGeneration: authority.link.generation,
            },
        });
        resolveExternalSessionObservationLinkInputMock.mockResolvedValue({
            target: {
                qualifiedLinkIdentity: authority.source.qualifiedIdentity,
            },
            resource: {
                resourceKey: authority.source.generation,
                pluginGeneration: authority.contributionGeneration,
            },
        });

        await expect(resolveExternalSessionTranscriptRefreshBinding({
            sessionId: authority.sessionId,
            cursor: 'happier_external_cursor_v1:Y3Vyc29yLTE',
            deviceLocalSecretStorage,
        })).resolves.toMatchObject({
            v: 1,
            machineId: authority.machineId,
            sessionId: authority.sessionId,
            cursorIdentity: expect.stringMatching(
                /^external_session_cursor_binding_v1:[0-9a-f]{64}$/,
            ),
        });
        expect(readStoredCredentialsMock).toHaveBeenCalledTimes(1);
        expect(readCredentialsMock).not.toHaveBeenCalled();
        expect(loadLinkedExternalSessionMock).toHaveBeenCalledWith(expect.objectContaining({
            credentials: {
                token: 'plain-token',
                encryption: null,
            },
        }));
    });

    it('fails closed before credential access when daemon device-local custody is absent', async () => {
        await expect(resolveExternalSessionTranscriptRefreshBinding({
            sessionId: authority.sessionId,
            cursor: 'happier_external_cursor_v1:Y3Vyc29yLTE',
        })).resolves.toBeNull();
        expect(readStoredCredentialsMock).not.toHaveBeenCalled();
        expect(readCredentialsMock).not.toHaveBeenCalled();
    });
});
