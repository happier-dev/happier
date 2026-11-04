import { ComputerCaptureResponseV1Schema, DaemonComputerActionExecuteResponseV1Schema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { describe, expect, it } from 'vitest';

import type { RpcHandler, RpcHandlerRegistrar, RpcHandlerContext } from '@/api/rpc/types';
import { captureResult, native, png } from '@/daemon/computer/driver/nativeComputerBoundary.testkit';
import { createComputerRoutes } from '@/daemon/computer/routes';
import { createComputerCaptureSource } from '@/daemon/computer/source';
import { createMachineLiveStreamCaptureRegistry } from '@/daemon/peer/mediation/stream/captureRegistry';

import { registerDaemonComputerHandler } from './daemonComputer';

function createCapturingRegistrar() {
    const handlers = new Map<string, RpcHandler>();
    const registrar: RpcHandlerRegistrar = {
        registerHandler: (method, handler) => { handlers.set(method, handler as RpcHandler); },
    };
    const invoke = async (raw: unknown, context?: RpcHandlerContext, method: string = RPC_METHODS.DAEMON_COMPUTER_ACTION_EXECUTE) => {
        const handler = handlers.get(method);
        if (!handler) throw new Error('No computer handler registered');
        return DaemonComputerActionExecuteResponseV1Schema.parse(await handler(raw, context)).result;
    };
    return { registrar, invoke };
}

function selectTarget(registry: ReturnType<typeof createMachineLiveStreamCaptureRegistry>, sessionId: string) {
    const source = createComputerCaptureSource({ sessionId, title: 'Sign in to Lumen',
        target: { kind: 'window', displayId: ':73', pid: 42, windowId: 7 }, executablePath: '/managed/native-driver' });
    registry.register({ sourceId: source.sourceId, streamFamily: 'screen', computer: source, adapter: source.adapter,
        capabilities: { v: 1, sourceId: source.sourceId, sourceKind: 'screen', supportedCodecs: ['image.frame.v1'],
            inputMode: 'shared', sidebands: [], health: { status: 'available' } } });
    return source;
}

describe('daemon computer present-user RPC', () => {
    it('selects and captures a Machine-person desktop without a Session for its admitted owner or manager', async () => {
        native.call.mockImplementation(async ({ name }) => name === 'list_windows'
            ? { structuredContent: { windows: [{ pid: 42, window_id: 123, title: 'Editor' }] } }
            : name === 'get_window_state' ? captureResult()
            : name === 'clipboard_read' ? { structuredContent: { supported: true, types: ['text/plain'], text: 'remote clipboard' } }
            : name === 'clipboard_write' ? { structuredContent: { supported: true, written_type: 'text' } }
            : { structuredContent: { x11: true, xsend_event: true } });
        const registry = createMachineLiveStreamCaptureRegistry();
        const routes = createComputerRoutes({ machineId: 'machine_1', defaultDisplayId: ':73',
            executablePath: '/managed/native-driver', registry });
        const { registrar, invoke } = createCapturingRegistrar();
        registerDaemonComputerHandler(registrar, { resolveComputer: () => routes });
        try {
            for (const [actorAccountId, role] of [['owner', 'manage'], ['manager', 'manage']] as const) {
                const context: RpcHandlerContext = { callerAuthority: 'present_user', signal: new AbortController().signal,
                    machineAdmission: { actorAccountId, custodianAccountId: 'owner', role,
                        machineId: 'machine_1', installationId: 'installation', encryptionMode: 'plain' } };
                const selected = await invoke({ actionId: 'computer.target.select', input: { machineId: 'machine_1',
                    target: { kind: 'window', displayId: ':73', pid: 42, windowId: 123 } } }, context);
                expect(selected).toMatchObject({ selectedTarget: { windowId: 123 } });
                const source = registry.list()[0]?.computer;
                expect(source).toMatchObject({ sourceIdentity: { kind: 'machine-person', personId: actorAccountId } });
                const captured = ComputerCaptureResponseV1Schema.parse(await invoke({ actionId: 'computer.capture',
                    input: { machineId: 'machine_1' } }, context));
                expect(captured).toMatchObject({ status: 'captured', frame: { mimeType: 'image/png', base64: png } });
                expect(captured).not.toHaveProperty('media');
                expect(await invoke({ actionId: 'computer.clipboard.read', input: { machineId: 'machine_1' } }, context))
                    .toEqual({ ok: true, text: 'remote clipboard' });
                expect(await invoke({ actionId: 'computer.clipboard.write', input: { machineId: 'machine_1', text: 'local clipboard' } }, context))
                    .toEqual({ ok: true });
                await routes.closeSession('unrelated-session');
                expect(source?.isClosed()).toBe(false);
                expect(await invoke({ actionId: 'computer.control.status', input: { machineId: 'machine_1', sourceId: source?.sourceId } },
                    { ...context, machineAdmission: { ...context.machineAdmission!, actorAccountId: 'another-manager' } }))
                    .toMatchObject({ ok: false, errorCode: 'computer_target_not_open' });
                await invoke({ actionId: 'computer.target.close', input: { machineId: 'machine_1' } }, context);
            }
        } finally { await routes.dispose(); }
    });

    it('keeps the personal route from reading the owner selection without requester placement', async () => {
        const registry = createMachineLiveStreamCaptureRegistry();
        const source = selectTarget(registry, 'session_1');
        const routes = createComputerRoutes({ machineId: 'machine_1', registry });
        const { registrar, invoke } = createCapturingRegistrar();
        registerDaemonComputerHandler(registrar, { resolveComputer: () => routes });
        const raw = { sessionId: 'session_1', actionId: 'computer.control.interrupt', input: { machineId: 'machine_1' } };
        const context = { callerAuthority: 'present_user', signal: new AbortController().signal } as const;
        native.call.mockImplementation(async ({ name }) => name === 'check_permissions'
            ? { structuredContent: { x11: true, xsend_event: true } } : { structuredContent: {} });
        try {
            expect(await invoke(raw, context)).toMatchObject({ target: source.target, status: 'interrupted' });
            expect(await invoke(raw, context, 'daemon.computer.personal.actions.execute'))
                .toMatchObject({ ok: false, errorCode: 'agent_isolation_unavailable' });
            expect(await invoke(raw, { ...context, callerAuthority: 'account_automation' }, 'daemon.computer.personal.actions.execute'))
                .toMatchObject({ ok: false, errorCode: 'approval_required' });
        } finally { await routes.dispose(); }
    });
    it('runs a person’s stop as the present user of the named Session, on this machine’s computer owner', async () => {
        const registry = createMachineLiveStreamCaptureRegistry();
        const source = selectTarget(registry, 'session_1');
        const routes = createComputerRoutes({ machineId: 'machine_1', machineDisplayName: 'Studio laptop', defaultDisplayId: ':73', registry });
        const { registrar, invoke } = createCapturingRegistrar();
        registerDaemonComputerHandler(registrar, { resolveComputer: () => routes });
        // The native driver process is the system boundary; status reads its OS grants.
        native.call.mockImplementation(async ({ name }) => name === 'check_permissions'
            ? { structuredContent: { x11: true, xsend_event: true } } : { structuredContent: {} });
        const context = { callerAuthority: 'present_user', signal: new AbortController().signal } as const;

        // A present-user-only Action succeeds: the route is the person's, never the payload's claim.
        expect(await invoke({ sessionId: 'session_1', actionId: 'computer.control.interrupt', input: { machineId: 'machine_1' } }, context))
            .toEqual({ target: source.target, sourceId: source.sourceId, provider: source.provider, status: 'interrupted', completion: 'known' });
        expect(await invoke({ sessionId: 'session_1', actionId: 'computer.control.status', input: { machineId: 'machine_1' } }, context))
            .toMatchObject({ controller: 'human', stopping: false, uncertain: false });
        // The Session scope is the request's: another Session sees no selection and display facts only.
        expect(await invoke({ sessionId: 'session_2', actionId: 'computer.target.get', input: { machineId: 'machine_1' } }, context))
            .toEqual({ provider: source.provider, consentGranted: false, approvalDisplay: { machineDisplayName: 'Studio laptop', requiresTargetSelection: true } });
        await routes.dispose();
    });

    it.each(['account_automation', undefined] as const)('keeps verified Computer authority %s and preserves control', async callerAuthority => {
        const registry = createMachineLiveStreamCaptureRegistry();
        const source = selectTarget(registry, 'session_1');
        const routes = createComputerRoutes({ machineId: 'machine_1', registry });
        const { registrar, invoke } = createCapturingRegistrar();
        registerDaemonComputerHandler(registrar, { resolveComputer: () => routes });
        const before = source.status();
        try {
            // This raw route is the person's; agents use the Computer Actions, whose policy owns Ask.
            for (const actionId of ['computer.control.interrupt', 'computer.control.status', 'computer.target.get', 'computer.targets.list', 'computer.clipboard.read', 'computer.clipboard.write'] as const) {
                expect(await invoke({ sessionId: 'session_1', actionId, input: { machineId: 'machine_1' } },
                    { callerAuthority, signal: new AbortController().signal })).toMatchObject({ ok: false, errorCode: 'approval_required' });
            }
            expect(source.status()).toEqual(before);
        } finally { await routes.dispose(); }
    });

    it('does not execute cancelled human Computer control', async () => {
        const registry = createMachineLiveStreamCaptureRegistry();
        const source = selectTarget(registry, 'session_1');
        const routes = createComputerRoutes({ machineId: 'machine_1', registry });
        const { registrar, invoke } = createCapturingRegistrar();
        registerDaemonComputerHandler(registrar, { resolveComputer: () => routes });
        const controller = new AbortController();
        controller.abort();
        const before = source.status();
        try {
            await expect(invoke({ sessionId: 'session_1', actionId: 'computer.control.interrupt', input: { machineId: 'machine_1' } },
                { callerAuthority: 'present_user', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
            expect(source.status()).toEqual(before);
        } finally { await routes.dispose(); }
    });

    it('never carries agent input and refuses when the machine has no computer owner', async () => {
        const { registrar, invoke } = createCapturingRegistrar();
        registerDaemonComputerHandler(registrar, { resolveComputer: () => null });
        await expect(invoke({ sessionId: 'session_1', actionId: 'computer.input',
            input: { machineId: 'machine_1', captureId: 'c', operation: { kind: 'type', text: 'x' } } })).rejects.toThrow();
        expect(await invoke({ sessionId: 'session_1', actionId: 'computer.control.status', input: { machineId: 'machine_1' } },
            { callerAuthority: 'present_user', signal: new AbortController().signal }))
            .toEqual({ ok: false, errorCode: 'computer_unavailable', error: 'computer_unavailable' });
    });
});
