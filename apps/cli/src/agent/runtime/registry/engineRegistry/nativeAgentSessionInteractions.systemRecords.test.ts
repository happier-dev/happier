import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    deleteSessionSystemRecordV1,
    fetchAccountEncryptionCurrentness,
    fetchServerFeaturesSnapshot,
    fetchSessionById,
    fetchSessionsPage,
    listSessionSystemRecordsV1,
    lookupSessionsByTags,
    readSessionSystemRecordV1,
    upsertSessionSystemRecordV1,
} = vi.hoisted(() => ({
    deleteSessionSystemRecordV1: vi.fn(),
    fetchAccountEncryptionCurrentness: vi.fn(),
    fetchServerFeaturesSnapshot: vi.fn(),
    fetchSessionById: vi.fn(),
    fetchSessionsPage: vi.fn(),
    listSessionSystemRecordsV1: vi.fn(),
    lookupSessionsByTags: vi.fn(),
    readSessionSystemRecordV1: vi.fn(),
    upsertSessionSystemRecordV1: vi.fn(),
}));

vi.mock('@/features/serverFeaturesClient', () => ({
    fetchServerFeaturesSnapshot: (...args: unknown[]) => fetchServerFeaturesSnapshot(...args),
}));
vi.mock('@/api/client/connectedServiceCredentialApi', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/api/client/connectedServiceCredentialApi')>(),
    fetchAccountEncryptionCurrentness: (...args: unknown[]) => fetchAccountEncryptionCurrentness(...args),
}));
vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
    fetchSessionById: (...args: unknown[]) => fetchSessionById(...args),
    fetchSessionsPage: (...args: unknown[]) => fetchSessionsPage(...args),
    lookupSessionsByTags: (...args: unknown[]) => lookupSessionsByTags(...args),
}));
vi.mock('@/session/transport/http/sessionSystemRecordsHttp', () => ({
    deleteSessionSystemRecordV1: (...args: unknown[]) => deleteSessionSystemRecordV1(...args),
    listSessionSystemRecordsV1: (...args: unknown[]) => listSessionSystemRecordsV1(...args),
    readSessionSystemRecordV1: (...args: unknown[]) => readSessionSystemRecordV1(...args),
    upsertSessionSystemRecordV1: (...args: unknown[]) => upsertSessionSystemRecordV1(...args),
}));

import type { Credentials } from '@/persistence';
import { FeaturesResponseSchema } from '@happier-dev/protocol';

import { createNativeAgentSessionServices } from './nativeAgentSessionInteractions';

const credentials = {
    token: 'account-token',
    encryption: { type: 'legacy', secret: new Uint8Array(32) },
} satisfies Credentials;

function readySystemRecordsFeatures() {
    return FeaturesResponseSchema.parse({
        features: {},
        capabilities: {
            session: {
                systemRecords: { protocolVersions: [1] },
            },
        },
    });
}

function workflowRunContent() {
    return Object.freeze({
        v: 1,
        projectionVersion: 1,
        runId: 'workflow-current',
        backendId: 'claude',
        agentId: 'claude',
        title: 'Current workflow',
        status: 'active',
        recordRevision: '1',
        updatedAt: 1,
        totalAgents: 0,
        completedAgents: 0,
        phases: [],
        agents: [],
    });
}

function storedHostWorkflowRecord() {
    return Object.freeze({
        id: 'record-1',
        address: Object.freeze({
            owner: 'host' as const,
            namespace: 'activity',
            kind: 'workflow_run.v1',
            localId: 'activity:workflow_run:v1:workflow-current',
        }),
        content: Object.freeze({ t: 'plain' as const, v: workflowRunContent() }),
        revision: 'ssr1.AAAAAWkAAAAB',
        createdAt: '2026-05-19T00:00:00.000Z',
        updatedAt: '2026-05-19T00:00:01.000Z',
    });
}

describe('native Agent Session public System Records dogfood', () => {
    beforeEach(() => {
        deleteSessionSystemRecordV1.mockReset();
        fetchAccountEncryptionCurrentness.mockReset();
        fetchServerFeaturesSnapshot.mockReset();
        fetchSessionById.mockReset();
        fetchSessionsPage.mockReset();
        listSessionSystemRecordsV1.mockReset();
        lookupSessionsByTags.mockReset();
        readSessionSystemRecordV1.mockReset();
        upsertSessionSystemRecordV1.mockReset();

        fetchServerFeaturesSnapshot.mockResolvedValue({
            status: 'ready',
            features: readySystemRecordsFeatures(),
        });
        fetchAccountEncryptionCurrentness.mockResolvedValue({
            mode: 'plain',
            version: 1,
            signingKeyFingerprint: null,
            contentKeyFingerprint: null,
            updatedAt: 1,
        });
        fetchSessionById.mockResolvedValue({
            id: 'session-record-0001',
            active: true,
            activeAt: 1,
            encryptionMode: 'plain',
            metadata: {},
        });
        upsertSessionSystemRecordV1.mockResolvedValue(storedHostWorkflowRecord());
    });

    it('uses the public Agent SessionHandle for a permission decision and host-owned workflow record write', async () => {
        const handleToolCall = vi.fn(async () => ({ decision: 'approved' as const }));
        const services = createNativeAgentSessionServices({
            permissionHandler: { handleToolCall },
            credentials,
            pluginId: 'acme.agent',
            contributionId: 'agent-runtime',
            runtimeId: 'acme.agent/runtime',
            sessionId: 'session-record-0001',
            generationId: 'generation-g',
            immutableGenerationId: 'generation-g',
            interactionDeadlineMs: 1_000,
            isCurrent: () => true,
            signal: new AbortController().signal,
        });
        const handle = services.sessions.current;
        if (!handle) throw new Error('Expected the current native Agent Session handle');

        await expect(handle.permissions.requestDecision({
            toolName: 'Bash',
            input: { command: 'pwd' },
        })).resolves.toEqual({ decision: 'approved' });
        await expect(handle.upsertSystemRecord({
            address: {
                owner: 'host',
                namespace: 'activity',
                kind: 'workflow_run.v1',
                localId: 'activity:workflow_run:v1:workflow-current',
            },
            content: workflowRunContent(),
        })).resolves.toMatchObject({ content: workflowRunContent() });

        expect(handleToolCall).toHaveBeenCalledWith(
            expect.stringMatching(/^plugin-session-permission:/),
            'Bash',
            { command: 'pwd' },
            expect.objectContaining({
                owner: {
                    kind: 'plugin',
                    pluginId: 'acme.agent',
                    runtimeId: 'acme.agent/runtime',
                },
            }),
        );
        expect(upsertSessionSystemRecordV1).toHaveBeenCalledWith({
            token: 'account-token',
            sessionId: 'session-record-0001',
            pluginId: 'acme.agent',
            request: {
                address: {
                    owner: 'host',
                    namespace: 'activity',
                    kind: 'workflow_run.v1',
                    localId: 'activity:workflow_run:v1:workflow-current',
                },
                content: { t: 'plain', v: workflowRunContent() },
            },
            signal: expect.any(AbortSignal),
        });
    });
});
