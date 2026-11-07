import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { ConnectedServiceBindingsV2Schema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { installNewSessionPreflightHarness, type PreflightCapabilityResponder } from '@/dev/testkit/harness/newSessionPreflightHarness';

const capabilityRpc = vi.fn<PreflightCapabilityResponder>();
const preflight = await installNewSessionPreflightHarness((...args) => capabilityRpc(...args));
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { useNewSessionScreenPreflightState } = await import('./useNewSessionScreenPreflightState');
const { buildSessionModelPickerSections } = await import('@/components/sessions/modelPicker/buildSessionModelPickerSections');
const { resetDynamicModelProbeCacheForTests } = await import('@/sync/domains/models/dynamicModelProbeCache');

beforeEach(async () => {
    await preflight.reset();
    resetDynamicModelProbeCacheForTests();
    capabilityRpc.mockReset();
    capabilityRpc.mockImplementation(async (_machineId, request) => {
        const bindings = ConnectedServiceBindingsV2Schema.safeParse(request.params?.connectedServices);
        return request.method === 'probeModels'
        ? bindings.success && bindings.data.bindingsByServiceId['happier.agent.codex/openai-codex']?.source === 'team_resource'
            ? { ok: false, error: { code: 'connected-service-preflight-failed', message: 'Team probes need Session authority' } }
            : { ok: true, result: { availableModels: [{ id: 'native-model', name: 'Native model' }], supportsFreeform: false } }
        : { ok: true, result: {} };
    });
});
afterEach(standardCleanup);
afterAll(() => preflight.dispose());

describe('new Session model source authority', () => {
    it.each(['brokered', 'direct', 'provider-model'] as const)(
        'uses the Team catalog for %s and resumes native/Account probing when the source changes', async (source) => {
            const agentTargetKey = 'agent:happier.agent.codex/codex';
            const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({
                id: 'resource-1', teamId: 'team-1', displayName: 'Team models', resourceRevision: 3,
                readiness: { kind: 'available' }, recoveryAction: null,
                mayBroker: true, mayReceiveDirect: true, directMaterialState: 'never_delivered',
                sessionUsePolicy: 'personal_allowed',
                providerModels: [{
                    selection: { kind: 'team_credential_provider_model', resourceId: 'resource-1', teamId: 'team-1',
                        expectedResourceRevision: 3, deliveryMode: source === 'direct' ? 'direct' : 'brokered',
                        agentTargetKey, modelId: 'team-model' },
                    descriptor: { id: 'team-model', name: 'Team model' },
                    application: { agentTargetKey,
                        implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
                        endpointTemplateId: 'cliproxyapi-openai-responses', protocol: 'openai-responses' },
                    sourceRevision: 'source-1', availability: 'available',
                }],
                sourcePresentation: { kind: 'provider', provider: {
                    identity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' }, definitionRevision: 1,
                } },
            });
            const teamSelection = resource.providerModels[0]!.selection;
            const teamBindings = ConnectedServiceBindingsV2Schema.parse({ v: 2, bindingsByServiceId: {
                'happier.agent.codex/openai-codex': { source: 'team_resource', resourceId: resource.id,
                    deliveryMode: source === 'direct' ? 'direct' : 'brokered',
                    ...(source === 'direct' ? { disclosedMember: {
                        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'member-1',
                    } } : {}),
                },
            } });
            const accountBindings = ConnectedServiceBindingsV2Schema.parse({ v: 2, bindingsByServiceId: {
                'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
            } });
            const hook = await renderHook(({ selectedSource, emptyCatalog }: {
                selectedSource: 'team' | 'native' | 'account'; emptyCatalog?: boolean;
            }) => {
                const state = useNewSessionScreenPreflightState({
                    backendTarget: { kind: 'backend', backendId: 'codex' }, runtimeCarrierAgentId: 'codex',
                    selectedMachineId: 'machine-1', capabilityServerId: preflight.serverId, cwd: '/repo',
                    connectedServicesBindingsPayload: selectedSource === 'team' && source !== 'provider-model'
                        ? teamBindings : selectedSource === 'account' ? accountBindings : null,
                    selectedTeamCredentialModel: selectedSource === 'team' && source === 'provider-model' ? teamSelection : null,
                });
                const sections = buildSessionModelPickerSections({ declarationContext: { kind: 'account' }, agentTargetKey,
                    nativeModels: state.modelOptions, providerGroups: [], hiddenNativeModelKeys: new Set(),
                    providerProjectionAuthoritative: true, teamCredentialResources: emptyCatalog ? [] : [resource],
                    teamCredentialResourceStatusByKey: new Map([['team-1:resource-1', { kind: 'current' as const }]]),
                });
                return { state, options: sections.flatMap(section => section.options) };
            }, { initialProps: { selectedSource: 'team' } });
            const nativeCalls = () => capabilityRpc.mock.calls.filter(([, request]) => request.method === 'probeModels');
            try {
                await flushHookEffects();
                expect(nativeCalls()).toHaveLength(0);
                expect(capabilityRpc.mock.calls.filter(([, request]) => request.method === 'probeConfigOptions')).toHaveLength(0);
                expect(hook.getCurrent().options.map(option => option.value?.modelId)).toEqual(['team-model']);
                expect(hook.getCurrent().options[0]?.disabled).toBe(false);
                expect(hook.getCurrent().state.modelOptionsProbeState).toMatchObject({ phase: 'idle', failed: false });

                await hook.rerender({ selectedSource: 'native' });
                await waitForHomeGovernance(async () => {
                    await flushHookEffects();
                    expect(nativeCalls()).toHaveLength(1);
                    expect(hook.getCurrent().state.modelOptions.some(option => option.value === 'native-model')).toBe(true);
                });
                await hook.rerender({ selectedSource: 'team' });
                await flushHookEffects();
                expect(nativeCalls()).toHaveLength(1);
                expect(hook.getCurrent().options.map(option => option.value?.modelId)).toEqual(['team-model']);
                expect(hook.getCurrent().state.modelOptionsProbeState).toMatchObject({ phase: 'idle', failed: false });
                await hook.rerender({ selectedSource: 'account' });
                await waitForHomeGovernance(async () => {
                    await flushHookEffects();
                    expect(nativeCalls()).toHaveLength(2);
                    expect(nativeCalls()[1]?.[1].params?.connectedServices).toEqual(accountBindings);
                    expect(hook.getCurrent().state.modelOptions.some(option => option.value === 'native-model')).toBe(true);
                });
                // A failed native observation remains owned by the native source.
                // Switching to Team must neither inherit it nor retry it.
                capabilityRpc.mockResolvedValue({ ok: false, error: { code: 'native-unavailable', message: 'Unavailable' } });
                await hook.rerender({ selectedSource: 'native' });
                await waitForHomeGovernance(async () => {
                    await flushHookEffects();
                    expect(nativeCalls()).toHaveLength(3);
                    expect(hook.getCurrent().state.modelOptionsProbeState.failed).toBe(true);
                });
                capabilityRpc.mockResolvedValue({ ok: true, result: {
                    configOptions: [], refreshError: true, refreshErrorMessage: 'Native configuration rejected',
                } });
                await act(async () => { hook.getCurrent().state.acpConfigOptionsProbeState.onRefresh(); });
                await waitForHomeGovernance(async () => {
                    await flushHookEffects();
                    expect(hook.getCurrent().state.acpConfigOptionsProbeState.failed).toBe(true);
                });
                await hook.rerender({ selectedSource: 'team' });
                expect(hook.getCurrent().options.map(option => option.value?.modelId)).toEqual(['team-model']);
                expect(hook.getCurrent().state.modelOptionsProbeState).toMatchObject({ phase: 'idle', failed: false });
                expect(hook.getCurrent().state.acpConfigOptionsProbeState).toMatchObject({ phase: 'idle', failed: false });
                await hook.rerender({ selectedSource: 'team', emptyCatalog: true });
                expect(hook.getCurrent().options).toEqual([]);
                expect(hook.getCurrent().state.modelOptionsProbeState).toMatchObject({ phase: 'idle', failed: false });
                expect(nativeCalls()).toHaveLength(3);
            } finally { await hook.unmount(); }
        },
    );
});
