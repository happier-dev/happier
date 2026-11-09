import { describe, expect, it, vi } from 'vitest';

import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SessionSpawnNewInputV2Schema, projectSessionSpawnNewActionInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createTargetedActionRpcRequestV1 } from '@happier-dev/protocol/actions/actionRpcTransport';
import { projectDiscussionModelParticipantLaunchV1 } from '@happier-dev/protocol/discussions/modelParticipantLaunch';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';

import { registerActionSpecRpcHandlers, unwrapActionResultForRpc } from './registerActionSpecRpcHandlers';

function createRpcHarness() {
    const handlers = new Map<string, (
        input: unknown,
        context?: Readonly<{ signal: AbortSignal }>,
    ) => Promise<unknown>>();
    return {
        handlers,
        rpcHandlerManager: {
            hasHandler(method: string) {
                return handlers.has(method);
            },
            registerHandler(
                method: string,
                handler: (input: unknown, context?: Readonly<{ signal: AbortSignal }>) => Promise<unknown>,
            ) {
                handlers.set(method, handler);
            },
        },
    };
}

const sessionSpawnInput = SessionSpawnNewInputV2Schema.parse({
    creationKey: 'manual:approval-transport-1',
    executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
    directory: { kind: 'path', path: '/tmp/project' },
    organizationPlacement: { folderId: null, tagIds: [] },
    agentTarget: {
        kind: 'agent' as const,
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
    },
});

describe('session.spawn_new Action RPC deferred approval transport', () => {
    it('admits the saved Discussion model launch observed in live QA through the canonical registered handler', async () => {
        const child = {
            executionTarget: { serverId: 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN', machineId: '588b5685-e43d-477d-8a1e-c0cb14015976' },
            directory: { kind: 'managed' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            configuration: {
                mode: { value: null, updatedAtMs: 1792392120000 },
                model: { value: 'gpt-6-luna', updatedAtMs: 1792392120000 },
                permissionIntent: { value: 'read-only', updatedAtMs: 1792392120000 },
                options: { reasoning_effort: { value: 'low', updatedAtMs: 1792392120000 } },
            },
            connectedServices: { v: 2, bindingsByServiceId: {
                'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: '97bd5614-8970-4068-87f2-1447de69d604' },
            } },
            permissionMode: 'read-only', title: 'N2 QA owned Codex model participant',
            creationKey: '9008714b-73f9-41f6-a1f5-a22e457a8a16',
            discussionParticipant: { discussionId: 'cmveqk4j10089m22ifjis8nvv', participantSlotId: '9008714b-73f9-41f6-a1f5-a22e457a8a16' },
            initialTriggers: [],
        };
        expect(SessionSpawnNewInputV2Schema.safeParse(child)).toMatchObject({ success: true });
        const spec = getActionSpec('session.spawn_new');
        const rpcParsed = spec.surfaceBindings?.rpc?.inputSchema.safeParse(child);
        expect(rpcParsed, JSON.stringify(rpcParsed)).toMatchObject({ success: true });
        // No launch dependencies are supplied: the real executor must refuse
        // unavailable execution, not the transport parsing of an admitted child.
        const executor = createActionExecutor(createUnavailableActionTransportDeps());
        const expected = unwrapActionResultForRpc('session.spawn_new', await executor.execute('session.spawn_new', child, {
            surface: 'rpc', authority: 'account_automation', serverId: child.executionTarget.serverId,
        }));
        expect(expected).not.toMatchObject({ errorCode: 'invalid_action_transport_input' });
        const { handlers, rpcHandlerManager } = createRpcHarness();
        registerActionSpecRpcHandlers({ rpcHandlerManager, actionExecutor: executor, actionSpecs: [spec],
            targetMachineId: child.executionTarget.machineId });
        const handler = handlers.get(RPC_METHODS.SESSION_SPAWN_NEW);
        expect(handler).toBeTypeOf('function');
        if (!handler) throw new Error('Canonical spawn RPC was not registered');
        await expect(handler(child)).resolves.toEqual(expected);
        await expect(handler(createTargetedActionRpcRequestV1(child, { kind: 'machine', machineId: child.executionTarget.machineId },
            { defaultSessionId: 'discussion-invoking-session' }))).resolves.toEqual(expected);
        const leakedHostFacts = { ...child, originKind: 'discussion',
            discussionParticipantLaunch: projectDiscussionModelParticipantLaunchV1(SessionSpawnNewInputV2Schema.parse(child)) };
        expect(spec.surfaceBindings?.rpc?.inputSchema.safeParse(leakedHostFacts)).toMatchObject({ success: false,
            error: { issues: [{ code: 'unrecognized_keys', path: [], keys: ['originKind', 'discussionParticipantLaunch'] }] } });
        await expect(handler(leakedHostFacts)).resolves.toEqual({ ok: false,
            errorCode: 'invalid_action_transport_input', error: 'invalid_action_transport_input' });
    });

    it('settles the canonical directory approval artifact instead of masking it as invalid transport output', async () => {
        const { handlers, rpcHandlerManager } = createRpcHarness();
        const execute = vi.fn(async () => ({
            ok: true as const,
            result: {
                kind: 'approval_request_created' as const,
                artifactId: 'approval-request-1',
                actionId: 'session.spawn_new' as const,
            },
        }));

        registerActionSpecRpcHandlers({
            rpcHandlerManager,
            actionExecutor: { execute },
            actionSpecs: [getActionSpec('session.spawn_new')],
        });

        const handler = handlers.get(RPC_METHODS.SESSION_SPAWN_NEW);
        expect(handler).toEqual(expect.any(Function));
        if (!handler) return;

        await expect(handler(sessionSpawnInput)).resolves.toEqual({
            kind: 'approval_request_created',
            artifactId: 'approval-request-1',
            actionId: 'session.spawn_new',
        });
        expect(execute).toHaveBeenCalledWith(
            'session.spawn_new',
            projectSessionSpawnNewActionInputV2(sessionSpawnInput),
            { surface: 'rpc', authority: 'account_automation' },
        );
    });

    it('keeps client-supplied caller provenance outside the strict Session spawn input', async () => {
        const { handlers, rpcHandlerManager } = createRpcHarness();
        const execute = vi.fn();

        registerActionSpecRpcHandlers({
            rpcHandlerManager,
            actionExecutor: { execute },
            actionSpecs: [getActionSpec('session.spawn_new')],
        });

        const handler = handlers.get(RPC_METHODS.SESSION_SPAWN_NEW);
        expect(handler).toEqual(expect.any(Function));
        if (!handler) return;

        await expect(handler({
            ...sessionSpawnInput,
            callerSurface: 'voice',
        })).resolves.toEqual({
            ok: false,
            errorCode: 'invalid_action_transport_input',
            error: 'invalid_action_transport_input',
        });
        expect(execute).not.toHaveBeenCalled();
    });
});
