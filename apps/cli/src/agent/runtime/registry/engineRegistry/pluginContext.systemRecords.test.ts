import { describe, expect, it, vi } from 'vitest';

import type { SessionSystemRecordWriteRequestV1 } from '@happier-dev/plugin-sdk';
import type { SessionSystemRecordUpsertRequest } from '@happier-dev/protocol';
import type { HostSessionRuntimeFactoryParams } from '@/agent/runtime/session/loop/runHostSessionRuntime';
import { readCredentials } from '@/persistence';
import {
    decryptSessionPayload,
    encryptSessionPayload,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { createHostPluginContextV1 } from './pluginContext';
import { readPluginContextV1Binder } from './pluginContext/binder';

vi.mock('@/persistence', () => ({
    readCredentials: vi.fn(async () => {
        throw new Error('readCredentials should not be used for session-owned system records');
    }),
}));

function createWorkflowRunPayload() {
    return {
        v: 1,
        projectionVersion: 1,
        runId: 'wf-tool-1',
        backendId: 'claude',
        agentId: 'claude',
        title: 'Implement Feature',
        status: 'active',
        workflowToolUseId: 'wf-tool-1',
        recordRevision: '1',
        updatedAt: 123,
        totalAgents: 0,
        completedAgents: 0,
        phases: [],
        agents: [],
    } as const;
}

describe('createHostPluginContextV1 system records', () => {
    it('seals plugin system-record writes with the active session client storage context', async () => {
        const encryptionKey = new Uint8Array(32);
        encryptionKey.fill(7);
        const upsertSessionSystemRecord = vi.fn(async (_request: SessionSystemRecordUpsertRequest) => undefined);
        const ctx = createHostPluginContextV1({ backendId: 'claude', happyHomeDir: '/tmp/happier-plugin-context-test' });
        const binder = readPluginContextV1Binder(ctx);
        if (!binder) throw new Error('expected plugin context binder');
        binder.bindHostSessionRuntime({
            directory: '/repo',
            machineId: 'machine-1',
            session: {
                sessionId: 's1',
                upsertSessionSystemRecord,
                getStoredContentEncryptionContext: () => ({
                    mode: 'e2ee',
                    ctx: {
                        encryptionKey,
                        encryptionVariant: 'legacy',
                    },
                }),
            },
            transcriptSession: {},
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: {},
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as unknown as HostSessionRuntimeFactoryParams);

        const request = {
            namespace: 'activity',
            kind: 'workflow_run.v1',
            localId: 'activity:workflow_run:v1:wf-tool-1',
            payload: createWorkflowRunPayload(),
            reason: 'claude_workflow_activity_record',
        } satisfies SessionSystemRecordWriteRequestV1;

        await ctx.sessions.current.writeSystemRecord?.(request);

        expect(readCredentials).not.toHaveBeenCalled();
        expect(upsertSessionSystemRecord).toHaveBeenCalledTimes(1);
        const [upsertRequest] = upsertSessionSystemRecord.mock.calls[0]!;
        expect(upsertRequest).toMatchObject({
            namespace: 'activity',
            kind: 'workflow_run.v1',
            localId: 'activity:workflow_run:v1:wf-tool-1',
        });
        if (upsertRequest.content.t !== 'encrypted') {
            throw new Error(`expected encrypted system record content, got ${upsertRequest.content.t}`);
        }
        expect(decryptSessionPayload({
            ctx: { encryptionKey, encryptionVariant: 'legacy' },
            ciphertextBase64: upsertRequest.content.c,
        })).toEqual(request.payload);
    });

    it('opens plugin system-record reads with the active session client storage context', async () => {
        const encryptionKey = new Uint8Array(32);
        encryptionKey.fill(11);
        const payload = createWorkflowRunPayload();
        const fetchSessionSystemRecord = vi.fn(async () => ({
            id: 'record-1',
            sessionId: 's1',
            namespace: 'activity',
            kind: 'workflow_run.v1',
            localId: 'activity:workflow_run:v1:wf-tool-1',
            content: {
                t: 'encrypted',
                c: encryptSessionPayload({
                    ctx: { encryptionKey, encryptionVariant: 'legacy' },
                    payload,
                }),
            },
            createdAt: '2026-07-01T00:00:00.000Z',
            updatedAt: '2026-07-01T00:00:01.000Z',
        }));
        const ctx = createHostPluginContextV1({ backendId: 'claude', happyHomeDir: '/tmp/happier-plugin-context-test' });
        const binder = readPluginContextV1Binder(ctx);
        if (!binder) throw new Error('expected plugin context binder');
        binder.bindHostSessionRuntime({
            directory: '/repo',
            machineId: 'machine-1',
            session: {
                sessionId: 's1',
                fetchSessionSystemRecord,
                getStoredContentEncryptionContext: () => ({
                    mode: 'e2ee',
                    ctx: {
                        encryptionKey,
                        encryptionVariant: 'legacy',
                    },
                }),
            },
            transcriptSession: {},
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: {},
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as unknown as HostSessionRuntimeFactoryParams);

        await expect(ctx.sessions.current.readSystemRecord?.({
            namespace: 'activity',
            localId: 'activity:workflow_run:v1:wf-tool-1',
            reason: 'claude_workflow_activity_record_readback',
        })).resolves.toEqual({
            namespace: 'activity',
            kind: 'workflow_run.v1',
            localId: 'activity:workflow_run:v1:wf-tool-1',
            payload,
        });

        expect(readCredentials).not.toHaveBeenCalled();
        expect(fetchSessionSystemRecord).toHaveBeenCalledWith({
            namespace: 'activity',
            localId: 'activity:workflow_run:v1:wf-tool-1',
        });
    });
});
