import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { installCapabilitiesOpsModuleMock } from '@/dev/testkit/mocks/capabilities';
import { createResolvedAgentCatalogEntryFixture } from '@/dev/testkit/fixtures/agentCatalogFixtures';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { buildDynamicModelProbeCacheKey } from '@/sync/domains/models/dynamicModelProbeCacheKey';
import { buildDynamicConfigOptionsProbeCacheKey } from '@/sync/domains/sessionControl/dynamicConfigOptionsProbeCacheKey';
import { resetDynamicConfigOptionsProbeCacheForTests, writeDynamicConfigOptionsProbeCacheSuccess } from '@/sync/domains/sessionControl/dynamicConfigOptionsProbeCache';
import {
    resetDynamicModelProbeCacheForTests,
    writeDynamicModelProbeCacheSuccess,
} from '@/sync/domains/models/dynamicModelProbeCache';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { ConnectedServiceBindingsV2Schema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams';
import { sessionModelSelectionKey } from '@/components/sessions/modelPicker/sessionModelSelectionKey';
import {
    normalizeNewSessionCapabilityProbeContextCacheKeySuffixParts,
    resolveNewSessionModelCapabilityProbeContext,
    withNewSessionConfigOptionOverrides,
} from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installNewSessionComponentsCommonModuleMocks();

const machineRpc = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops/capabilities', (importOriginal) => (
    installCapabilitiesOpsModuleMock({ machineCapabilitiesInvoke: machineRpc })(importOriginal)
));
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return {
        ...original,
        createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original),
    };
});

const { NewSessionEngineOptionDetail } = await import('./NewSessionEngineOptionDetail');
const { buildSessionAgentPickerDetailContent } = await import('@/components/sessions/agentPicker/buildSessionAgentPickerDetailContent');

describe('NewSessionEngineOptionDetail Codex catalog arrival', () => {
    beforeEach(() => {
        machineRpc.mockReset();
        resetDynamicModelProbeCacheForTests();
        resetDynamicConfigOptionsProbeCacheForTests();
    });

    it('keeps a personal connected-account model outside the native catalog', async () => {
        machineRpc.mockImplementation(() => new Promise(() => undefined));
        const backendTarget = { kind: 'backend' as const, backendId: 'codex' };
        const agentTargetKey = resolveBackendTargetKeyV2(backendTarget);
        const capabilityProbeContext = { capabilityParams: { connectedServices: ConnectedServiceBindingsV2Schema.parse({ v: 2,
            bindingsByServiceId: { 'happier.agent.muse/muse-account': {
                source: 'connected', selection: 'profile', profileId: 'work',
            } },
        }) } };
        const cacheKey = buildDynamicModelProbeCacheKey({ machineId: 'machine-58f6', targetKey: agentTargetKey,
            providerConnectionId: null, serverId: 'server-main', cwd: '/workspace',
            extraKeySuffixParts: normalizeNewSessionCapabilityProbeContextCacheKeySuffixParts(capabilityProbeContext) })!;
        writeDynamicModelProbeCacheSuccess(cacheKey, { source: 'dynamic',
            availableModels: [{ id: 'gpt-6-luna', name: 'GPT 6 Luna' }], supportsFreeform: false });
        const modelId = 'meta/muse-spark-1.3-contributor';
        const onSelectionChange = vi.fn();
        await renderScreen(<NewSessionEngineOptionDetail backendTarget={backendTarget} selectedMachineId="machine-58f6"
            capabilityServerId="server-main" cwd="/workspace" capabilityProbeContext={capabilityProbeContext}
            selectedModelId={modelId} selectedModelSelection={{ v: 1, updatedAt: 1,
                ref: { agentTargetKey, providerConnectionId: null, modelId } }} onSelectionChange={onSelectionChange} />);
        await flushHookEffects();
        expect(onSelectionChange).not.toHaveBeenCalled();
    });

    it.each(['source', 'model'] as const)('keeps a Team %s usable without native model or configuration probes', async (choice) => {
        machineRpc.mockResolvedValue({ ok: false, error: {
            code: 'connected-service-preflight-failed', message: 'Team probes require Session authority',
        } });
        const backendTarget = { kind: 'backend' as const, backendId: 'codex' };
        const agentTargetKey = resolveBackendTargetKeyV2(backendTarget);
        const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({
            id: 'resource-1', teamId: 'team-1', displayName: 'Team Codex', resourceRevision: 3,
            readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
            directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed',
            providerModels: [{
                selection: { kind: 'team_credential_provider_model', resourceId: 'resource-1', teamId: 'team-1',
                    expectedResourceRevision: 3, deliveryMode: 'brokered', agentTargetKey, modelId: 'team-model' },
                descriptor: { id: 'team-model', name: 'Team model' },
                application: { agentTargetKey, implementationIdentity: { pluginId: 'provider.openai', localId: 'openai' },
                    endpointTemplateId: 'responses', protocol: 'openai-responses' },
                sourceRevision: 'source-1', availability: 'available',
            }],
            sourcePresentation: { kind: 'provider', provider: {
                identity: { pluginId: 'provider.openai', localId: 'openai' }, definitionRevision: 1,
            } },
        });
        const selection = resource.providerModels[0]!.selection;
        const onSelectTeamCredentialModel = vi.fn();
        const screen = await renderScreen(buildSessionAgentPickerDetailContent({
            backendTarget, agentCatalogEntry: createResolvedAgentCatalogEntryFixture({ agentId: 'codex' }),
            runtimeCarrierAgentId: 'codex', selectedMachineId: 'machine-58f6', capabilityServerId: 'server-main',
            cwd: '/workspace', settings: settingsDefaults,
            connectedServices: choice === 'model' ? null : ConnectedServiceBindingsV2Schema.parse({ v: 2, bindingsByServiceId: {
                'happier.agent.codex/openai-codex': { source: 'team_resource', resourceId: resource.id, deliveryMode: 'brokered' },
            } }),
            selection: { modelId: 'default', modelSelection: null, sessionModeId: 'default', configOverrides: {} },
            teamModels: { teamCredentialResources: [resource],
                teamCredentialResourceStatusByKey: new Map([['team-1:resource-1', { kind: 'current' }]]),
                selectedTeamCredentialModel: choice === 'model' ? selection : null,
                onSelectTeamCredentialModel, onSelectOtherModel: () => {} },
            onSelectionChange: () => {},
        }));
        await flushHookEffects();
        expect(machineRpc.mock.calls.filter(([, request]) =>
            request.method === 'probeModels' || request.method === 'probeConfigOptions')).toHaveLength(0);
        expect(screen.findByTestId('model-picker-overlay-probe-failure')).toBeNull();
        const option = screen.findByTestId(`model-picker-overlay-option:${sessionModelSelectionKey(selection)}`);
        expect(option).not.toBeNull();
        await act(async () => { option!.props.onPress(); });
        expect(onSelectTeamCredentialModel).toHaveBeenCalledWith(selection);
    });

    it('drops stale scoped draft values after an accepted narrower catalog even when the model id is unchanged', async () => {
        machineRpc.mockImplementation(() => new Promise(() => undefined));
        const backendTarget = { kind: 'backend' as const, backendId: 'codex' };
        const desired = { provider: 'gateway', effort: 'ultra' };
        const context = withNewSessionConfigOptionOverrides(null, desired);
        const commonKey = { machineId: 'machine-58f6', targetKey: resolveBackendTargetKeyV2(backendTarget),
            serverId: 'server-main', cwd: '/workspace', extraKeySuffixParts: normalizeNewSessionCapabilityProbeContextCacheKeySuffixParts(context) };
        const effort = { id: 'effort', name: 'Thinking', type: 'select', currentValue: 'auto', options: [{ value: 'auto', name: 'Auto' }] };
        writeDynamicModelProbeCacheSuccess(buildDynamicModelProbeCacheKey({ ...commonKey, providerConnectionId: null })!, {
            availableModels: [{ id: 'shared-model', name: 'Shared model', modelOptions: [effort] }], supportsFreeform: false,
        });
        writeDynamicConfigOptionsProbeCacheSuccess(buildDynamicConfigOptionsProbeCacheKey(commonKey)!, [
            { id: 'provider', name: 'Provider', type: 'select', currentValue: 'gateway', options: [{ value: 'gateway', name: 'Gateway' }] }, effort,
        ]);
        let latest = { modelId: 'shared-model', configOverrides: desired as Readonly<Record<string, string>> };
        await renderScreen(<NewSessionEngineOptionDetail backendTarget={backendTarget} selectedMachineId="machine-58f6"
            capabilityServerId="server-main" cwd="/workspace" selectedModelId="shared-model" selectedConfigOverrides={desired}
            onSelectionChange={(selection) => { latest = selection; }} />);
        await flushHookEffects();
        expect(latest).toMatchObject({ modelId: 'shared-model', configOverrides: { provider: 'gateway' } });
        expect(latest.configOverrides).not.toHaveProperty('effort');
    });

    it('keeps newer draft values while only the previous context has an authoritative catalog', async () => {
        machineRpc.mockImplementation(() => new Promise(() => undefined));
        const backendTarget = { kind: 'backend' as const, backendId: 'codex' };
        const previous = { provider: 'native', effort: 'auto' };
        const desired = { provider: 'gateway', effort: 'ultra' };
        const context = withNewSessionConfigOptionOverrides(null, previous);
        const commonKey = { machineId: 'machine-58f6', targetKey: resolveBackendTargetKeyV2(backendTarget),
            serverId: 'server-main', cwd: '/workspace', extraKeySuffixParts: normalizeNewSessionCapabilityProbeContextCacheKeySuffixParts(context) };
        const effort = { id: 'effort', name: 'Thinking', type: 'select', currentValue: 'auto', options: [{ value: 'auto', name: 'Auto' }] };
        writeDynamicModelProbeCacheSuccess(buildDynamicModelProbeCacheKey({ ...commonKey, providerConnectionId: null })!, {
            availableModels: [{ id: 'shared-model', name: 'Shared model', modelOptions: [effort] }], supportsFreeform: false,
        });
        writeDynamicConfigOptionsProbeCacheSuccess(buildDynamicConfigOptionsProbeCacheKey(commonKey)!, [
            { id: 'provider', name: 'Provider', type: 'select', currentValue: 'native', options: [{ value: 'native', name: 'Native' }, { value: 'gateway', name: 'Gateway' }] }, effort,
        ]);
        const nextContext = withNewSessionConfigOptionOverrides(null, desired);
        writeDynamicModelProbeCacheSuccess(buildDynamicModelProbeCacheKey({ ...commonKey, providerConnectionId: null,
            extraKeySuffixParts: normalizeNewSessionCapabilityProbeContextCacheKeySuffixParts(nextContext) })!, {
            availableModels: [{ id: 'shared-model', name: 'Shared model', modelOptions: [{ ...effort,
                options: [{ value: 'auto', name: 'Auto' }, { value: 'ultra', name: 'Ultra' }] }] }], supportsFreeform: false,
        });
        let latest: Readonly<Record<string, string>> = previous;
        const content = (overrides: Readonly<Record<string, string>>) => <NewSessionEngineOptionDetail backendTarget={backendTarget}
            selectedMachineId="machine-58f6" capabilityServerId="server-main" cwd="/workspace" selectedModelId="shared-model"
            selectedConfigOverrides={overrides} onSelectionChange={(selection) => { latest = selection.configOverrides; }} />;
        const screen = await renderScreen(content(previous));
        await flushHookEffects();
        latest = desired;
        await screen.update(content(desired));
        await flushHookEffects();
        expect(latest).toEqual(desired);
    });

    it('names the selected native account or pool through the shared Agent detail builder', async () => {
        machineRpc.mockImplementation(() => new Promise(() => undefined));
        const backendTarget = { kind: 'backend' as const, backendId: 'codex' };
        const probeContext = resolveNewSessionModelCapabilityProbeContext({
            backendTarget,
            settings: settingsDefaults,
            connectedServices: null,
        });
        const cacheKey = buildDynamicModelProbeCacheKey({
            machineId: 'machine-58f6',
            targetKey: resolveBackendTargetKeyV2(backendTarget),
            providerConnectionId: null,
            serverId: 'server-main',
            cwd: '/workspace',
            extraKeySuffixParts: normalizeNewSessionCapabilityProbeContextCacheKeySuffixParts(probeContext),
        });
        expect(cacheKey).not.toBeNull();
        writeDynamicModelProbeCacheSuccess(cacheKey!, {
            availableModels: [{ id: 'gpt-6-luna', name: 'GPT 6 Luna' }],
            supportsFreeform: true,
        });
        const sourceLabel = 'Codex · Work pool';
        const screen = await renderScreen(buildSessionAgentPickerDetailContent({
            backendTarget,
            agentCatalogEntry: createResolvedAgentCatalogEntryFixture({ agentId: 'codex' }),
            selectedMachineId: 'machine-58f6',
            capabilityServerId: 'server-main',
            cwd: '/workspace',
            settings: settingsDefaults,
            connectedServices: null,
            nativeSourceLabel: sourceLabel,
            selection: { modelId: 'default', modelSelection: null, sessionModeId: 'default', configOverrides: {} },
            onSelectionChange: () => {},
        }));
        await flushHookEffects();

        expect(screen.findByTestId('model-picker-overlay-option:["agent:happier.agent.codex/codex",null,"gpt-6-luna"]')).not.toBeNull();
        expect(screen.findAll((node) => typeof node.type === 'string' && node.children.includes(sourceLabel))).not.toHaveLength(0);
    });

    it('keeps the real picker stable when the Codex model catalog arrives asynchronously', async () => {
        machineRpc.mockImplementation(() => new Promise(() => undefined));
        const backendTarget = { kind: 'backend' as const, backendId: 'codex' };
        const cacheKey = buildDynamicModelProbeCacheKey({
            machineId: 'machine-58f6',
            targetKey: resolveBackendTargetKeyV2(backendTarget),
            providerConnectionId: null,
            serverId: 'server-main',
            cwd: '/workspace',
        });
        expect(cacheKey).not.toBeNull();
        writeDynamicModelProbeCacheSuccess(cacheKey!, {
            availableModels: [],
            supportsFreeform: true,
        });

        const screen = await renderScreen(
            <NewSessionEngineOptionDetail
                backendTarget={backendTarget}
                selectedMachineId="machine-58f6"
                capabilityServerId="server-main"
                cwd="/workspace"
                selectedModelId="default"
                selectedSessionModeId="default"
                selectedConfigOverrides={{}}
            />,
        );
        await flushHookEffects();

        await act(async () => {
            writeDynamicModelProbeCacheSuccess(cacheKey!, {
                availableModels: [
                    { id: 'gpt-6-luna', name: 'GPT 6 Luna' },
                    { id: 'catalog-only-codex', name: 'Catalog only Codex' },
                ],
                supportsFreeform: true,
            });
        });

        expect(screen.findByTestId(
            'model-picker-overlay-option:["agent:happier.agent.codex/codex",null,"gpt-6-luna"]',
        )).toBeTruthy();
        expect(screen.findByTestId('model-picker-overlay-custom-input')).toBeNull();
    });
});
