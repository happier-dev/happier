import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { RPC_METHODS, type DaemonProviderModelProjectionResponseV1 } from '@happier-dev/protocol/rpc';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness,
    installProviderSettingsRpcBoundary, createProviderModelProjectionFixture,
    createProviderModelProjectionGroupFixture } from '@/dev/testkit/harness/providerSettingsHarness';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';

const rpc = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { useAgentModelsProjection } = await import('./useAgentModelsProjection');
let serverId = '';
const connectionIds = ['pc_a'];

describe('Agent Models Account/machine projection', () => {
    beforeEach(async () => {
        rpc.reset();
        serverId = (await account.restore({ machines: rpc.state.machines })).serverId;
    });
    afterEach(async () => { standardCleanup(); await account.reset(); });

    it('keeps the typed Account refusal without a fallback machine', async () => {
        const hook = await renderHook(() => useAgentModelsProjection({ enabled: true, machineId: null,
            serverId, agentTargetKey: 'agent:acme.dynamic/coder', connectionIds }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().error?.code).toBe('provider_agent_runtime_unsupported'));
        expect(hook.getCurrent().loading).toBe(false);
        expect(rpc.state.requests).toEqual([]);
    });

    it.each(['success', 'failure'] as const)('waits for the dynamic Agent machine fallback and exposes its %s', async outcome => {
        const agentTargetKey = 'agent:acme.dynamic/coder';
        let settle!: (result: DaemonProviderModelProjectionResponseV1) => void;
        const response = new Promise<DaemonProviderModelProjectionResponseV1>(resolve => { settle = resolve; });
        rpc.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, () => response);
        const hook = await renderHook(() => useAgentModelsProjection({ enabled: true, machineId: 'machine-a',
            serverId, agentTargetKey, connectionIds }));
        await waitForHomeGovernance(() => expect(rpc.state.requests.some(request =>
            request.method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION)).toBe(true));
        // Let the Account-only owner finish its unsupported result while machine transport waits.
        await flushHookEffects({ cycles: 5, turns: 5 });
        const pending = { loading: hook.getCurrent().loading, error: hook.getCurrent().error };
        const refusal = createProviderErrorV1('provider_endpoint_unreachable', { machineId: 'machine-a' });
        await act(async () => { settle(outcome === 'failure' ? { status: 'error', error: refusal }
            : createProviderModelProjectionFixture({ agentTargetKey, groups: ['pc_a', 'pc_foreign'].map(connectionId =>
                createProviderModelProjectionGroupFixture({ connectionId, rows: [{
                    ref: { agentTargetKey, providerConnectionId: connectionId, modelId: 'dynamic-model' },
                    descriptor: { id: 'dynamic-model', name: 'Dynamic model' },
                    sources: { manual: false, static: true, probe: false }, confidence: 'verified_static',
                    compatibility: { result: { status: 'verified', selectedProtocol: 'openai-responses',
                        evidence: { sourceUrls: ['https://models.example.test'], verifiedAt: '2026-10-12' } },
                        compatibilityFingerprint: 'compatibility:v1:dynamic', confirmed: true },
                    endpointHealth: 'available', catalog: { stale: false }, loadState: 'loaded', visibility: 'visible',
                }] })) })); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
        expect(pending).toEqual({ loading: true, error: null });
        if (outcome === 'failure') expect(hook.getCurrent().error).toEqual(refusal);
        else {
            expect(hook.getCurrent().error).toBeNull();
            expect(hook.getCurrent().data?.groups.map(group => group.connectionId)).toEqual(['pc_a']);
            expect(hook.getCurrent().data?.groups[0]?.rows[0]?.ref.agentTargetKey).toBe(agentTargetKey);
        }
    });
});
