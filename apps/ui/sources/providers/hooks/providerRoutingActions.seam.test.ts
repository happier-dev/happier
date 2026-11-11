import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ProviderBoundModelRefSchema } from '@happier-dev/protocol/providers/model-selection';
import { SessionModelTransitionRequestV1Schema, SessionModelTransitionResultV1Schema } from '@happier-dev/protocol/sessions/control/modelTransitionV1';
import { projectExecutionRunChildChoiceV1, withExecutionRunStartFailureDetails, ExecutionRunStartFailureDetailsV1Schema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { ManagedMachineActionOutputSchemasV1, managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { installSessionActionFixture, installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { standardCleanup } from '@/dev/testkit';

// Only Home HTTP/credentials and the remote Session Socket transport are substituted.
// The default executor, Account capture, Action admission, scoped client and strict codecs stay real.
const account = createProviderSettingsAccountHarness();
let respond: Parameters<typeof installSessionActionRpcBoundary>[0] = () => { throw new Error('Unexpected Session RPC'); };
const requests = installSessionActionRpcBoundary((request, context) => respond(request, context));
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
afterEach(async () => { standardCleanup(); await account.reset(); requests.length = 0; });

describe('Provider routing Actions through the real UI composition', () => {
    it('un-arms only the addressed Session through its canonical transition RPC and rejects an invalid terminal reply', async () => {
        const { serverId, accountId } = await account.restore({ machines: [createMachineFixture({ id: 'machine_1', active: true, activeAt: Date.now() })] });
        installSessionActionFixture({ homes: account.home, storage, serverId, session: { id: 'lead' } });
        const activeSelection = { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: 'pc_applied', modelId: 'applied-model' };
        let armed = true;
        let invalidReply = false;
        respond = request => {
            if (request.method !== `lead:${SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION}`) throw new Error('Wrong Session transition wiring');
            expect(SessionModelTransitionRequestV1Schema.parse(request.params)).toEqual({ v: 1, unarm: true });
            armed = false;
            const result = SessionModelTransitionResultV1Schema.parse({ ok: true, status: 'already_active', activeSelection });
            return invalidReply ? { ...result, credential: 'must-not-cross-the-seam' } : result;
        };
        const context = { serverId, expectedAccountId: accountId, surface: 'ui' as const, authority: 'present_user' as const };
        expect(await createDefaultActionExecutor().execute('session.model.unarm', { sessionId: 'lead' }, context))
            .toEqual({ ok: true, result: { ok: true, status: 'already_active', activeSelection } });
        expect(armed).toBe(false);
        expect(requests).toHaveLength(1);
        invalidReply = true;
        expect(await createDefaultActionExecutor().execute('session.model.unarm', { sessionId: 'lead' }, context))
            .toMatchObject({ ok: false });
    });

    it('preserves the runtime failure cause through a failed Session model mutation Action', async () => {
        const { serverId, accountId } = await account.restore({ machines: [createMachineFixture({ id: 'machine_1', active: true, activeAt: Date.now() })] });
        installSessionActionFixture({ homes: account.home, storage, serverId, session: { id: 'lead' } });
        const activeSelection = { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: 'pc_applied', modelId: 'applied-model' };
        const requestedSelection = { ...activeSelection, providerConnectionId: 'pc_requested', modelId: 'requested-model' };
        const failureCause = { phase: 'turn_start', failureReason: 'unclassified_provider_error', providerErrorCode: -32602 };
        respond = request => {
            if (request.method !== `lead:${SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION}`) throw new Error('Wrong Session transition wiring');
            expect(SessionModelTransitionRequestV1Schema.parse(request.params)).toEqual({ v: 1, selection: requestedSelection });
            return SessionModelTransitionResultV1Schema.parse({ ok: false, status: 'apply_failed', activeSelection,
                requestedSelection, reason: 'provider_request_failed', failureCause });
        };
        const result = await createDefaultActionExecutor().execute('session.model.set', {
            sessionId: 'lead', providerConnectionId: requestedSelection.providerConnectionId, modelId: requestedSelection.modelId,
        }, { serverId, expectedAccountId: accountId, surface: 'ui', authority: 'present_user' });
        expect(result).toMatchObject({ ok: false, errorCode: 'apply_failed', details: {
            status: 'apply_failed', activeSelection, requestedSelection, reason: 'provider_request_failed', failureCause,
        } });
    });

    it('preserves the host-produced child choice and no-Run-created evidence through attached start and Action error normalization', async () => {
        const { serverId, accountId } = await account.restore({ serverIdentityId: 'srv_provider_routing',
            machines: [createMachineFixture({ id: 'machine_1', active: true, activeAt: Date.now() })] });
        installSessionActionFixture({ homes: account.home, storage, serverId, session: { id: 'lead' } });
        // Run admission resolves the Session's managed association through its Home.
        // This fixture's enrolled Machine is unmanaged; keep that HTTP read real.
        account.home.answer(serverId, managedMachineActionEndpointPathV1('machines.managed.list'), {
            body: ManagedMachineActionOutputSchemasV1['machines.managed.list'].parse({ machines: [] }),
        });
        const childChoice = projectExecutionRunChildChoiceV1({ agentTargetKey: 'agent:happier.agent.claude/claude',
            parentModelSelection: ProviderBoundModelRefSchema.parse({ agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: 'pc_parent', modelId: 'parent-model' }),
            parentRouteCompatibility: 'incompatible' });
        const details = withExecutionRunStartFailureDetails({ childChoice }, 'noRunCreated');
        respond = request => {
            if (request.method !== `lead:${SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1}`) throw new Error('Wrong attached-child start wiring');
            return { ok: false, error: 'Choose the child model', errorCode: 'execution_run_child_choice_required', details };
        };
        const result = await createDefaultActionExecutor().execute('execution.run.start', { sessionId: 'lead', intent: 'delegate',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, instructions: 'Review the changes',
            permissionMode: 'default', runClass: 'bounded', ioMode: 'request_response', retentionPolicy: 'ephemeral' },
            { serverId, expectedAccountId: accountId, surface: 'ui', authority: 'present_user' });
        expect(result).toMatchObject({ ok: false, errorCode: 'execution_run_child_choice_required', details });
        if (result.ok) throw new Error('A child choice refusal must never become a successful Run');
        expect(ExecutionRunStartFailureDetailsV1Schema.parse(result.details)).toEqual(details);
        expect(requests).toHaveLength(1);
    });
});
