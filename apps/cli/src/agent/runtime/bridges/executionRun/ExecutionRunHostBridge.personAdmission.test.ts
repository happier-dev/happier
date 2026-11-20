import { describe, expect, it, vi } from 'vitest';

const { createBundledPluginPublicationFsFixture } = await vi.hoisted(async () =>
    import('@/plugins/projection/registry/builtIn/locators.testkit'));
vi.mock('node:fs', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return createBundledPluginPublicationFsFixture(actual);
});

import { ExecutionRunGetResponseSchema, ExecutionRunStartResponseSchema } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { withAdmittedSessionRun } from './testkit/admittedSessionRun';
import { createNativeSessionBoundary } from './testkit/nativeSessionContext';

describe('present-user attached Run admission', () => {
    it.each([false, true])('retains the authenticated caller with narrowed permissions %s', async narrowed => {
        await withAdmittedSessionRun({ parentRuntime: true, run: async fixture => {
            const native = createNativeSessionBoundary();
            fixture.nativeOpen.mockImplementation(native.open);
            const raw = await fixture.rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
                sessionId: fixture.session.sessionId, intent: 'delegate', backendTarget: { kind: 'agent', identity: fixture.agentIdentity },
                instructions: 'Inspect the captured changes.', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
                runClass: 'bounded', ioMode: 'request_response', modelSelection: null, connectedServices: null,
            }, { verifiedPeerAuthority: 'present_user', localActionContext: {
                surface: 'rpc', authority: 'present_user',
                ...(narrowed ? { callerPermissionMode: 'read_only', agentStartWorkspaceWrites: 'deny' } as const : {}),
            } });
            expect(raw, JSON.stringify(raw)).toMatchObject({ runId: expect.any(String) });
            const started = ExecutionRunStartResponseSchema.parse(raw);
            try {
                await native.waitForInputs(1);
                expect(native.opens).toMatchObject([{ sessionId: fixture.session.sessionId,
                    configuration: { permissionIntent: { value: 'read-only' } } }]);
                native.complete();
                await fixture.rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_WAIT, { runId: started.runId },
                    { verifiedPeerAuthority: 'present_user' });
                const result = ExecutionRunGetResponseSchema.parse(await fixture.rpc.invokeLocal(
                    SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId }, { verifiedPeerAuthority: 'present_user' }));
                expect(result.run).toMatchObject({ status: 'succeeded', permissionMode: 'read_only' });
            } finally {
                await fixture.rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_STOP, { runId: started.runId },
                    { verifiedPeerAuthority: 'present_user' });
            }
        } });
    });
});
