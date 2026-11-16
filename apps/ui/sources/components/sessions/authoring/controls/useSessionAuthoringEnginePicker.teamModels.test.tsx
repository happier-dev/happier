import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkflowStepExecutionSelectionSchema, type WorkflowStepExecutionSelection } from '@happier-dev/protocol/workflows/workflowV1';
import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { renderHook, renderScreen, standardCleanup, teamSummaryFixture, createRootLayoutFeaturesResponse } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from '@/components/sessions/agentInput/agentInputTestHelpers';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness, createProviderModelProjectionFixture,
    installProviderSettingsRpcBoundary, installBundledProviderDeclarationsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';

installAgentInputCommonModuleMocks();
vi.mock('expo-image', () => ({ Image: 'Image' }));
const rpc = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(rpc);
installBundledProviderDeclarationsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { useSessionAuthoringEnginePicker } = await import('./useSessionAuthoringEnginePicker');
const { getResolvedBackendCatalogEntries } = await import('@/agents/backendCatalog/getResolvedBackendCatalogEntries');
afterEach(async () => { await standardCleanup(); await account.reset(); });

it('offers a Team provider model on the authored Machine and round-trips its exact application without a native model carrier', async () => {
    const agentTargetKey = 'agent:happier.agent.codex/codex';
    const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({
        id: 'qa-ent-1107-sd-muse', teamId: 'team-b', displayName: {
            content: { t: 'plain', v: 'Team Muse' }, recipientEnvelope: null, legacyPlaintext: true,
        }, resourceRevision: 1,
        readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
        allowedRoutes: ['brokered'], directMaterialState: 'revoked', sessionUsePolicy: 'personal_allowed',
        connectedServiceSelections: [], sourcePresentation: { kind: 'connected_service',
            service: { pluginId: 'happier.agent.muse', localId: 'muse-account' } },
        providerModels: [{ selection: { kind: 'team_credential_provider_model', resourceId: 'qa-ent-1107-sd-muse',
            teamId: 'team-b', expectedResourceRevision: 1, agentTargetKey, modelId: 'muse-spark-1.3-contributor', deliveryMode: 'brokered' },
            descriptor: { id: 'muse-spark-1.3-contributor', name: 'Muse contributor', modelOptions: [{
                id: 'reasoning_effort', name: 'Reasoning effort', type: 'select', currentValue: 'max',
                options: [{ value: 'minimal', name: 'Minimal' }, { value: 'max', name: 'Max' }],
            }] },
            application: { agentTargetKey, implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
                endpointTemplateId: 'cliproxyapi-openai-responses', protocol: 'openai-responses' },
            sourceRevision: 'catalog-228', availability: 'available' }],
    });
    rpc.setResponse(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, createProviderModelProjectionFixture({
        agentTargetKey, groups: [], teamCredentialResources: [resource],
    }));
    const { serverId } = await account.restore({ accountId: 'account-b', features: createRootLayoutFeaturesResponse({ features: {
        providers: { enabled: true }, teams: { enabled: true, credentialResources: { enabled: true } },
    } }), httpAnswers: {
        '/v1/teams/list': { body: { items: [teamSummaryFixture({ id: 'team-b' })], nextCursor: null } },
        '/v1/teams/credential-resources/entitled/list': { body: { resources: [resource], nextCursor: null } },
        '/v1/teams/credential-resources/entitled/discover': { body: { resources: [resource], nextCursor: null, failures: [] } },
    } });
    const entry = getResolvedBackendCatalogEntries({ enabledAgentIds: ['codex'] })[0]!;
    const values = WorkflowStepExecutionSelectionSchema.parse({ agentTarget: { kind: 'agent',
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        sessionConfigOptionOverrides: { v: 1, updatedAt: 1, overrides: { reasoning_effort: { value: 'minimal', updatedAt: 1 } } },
    });
    const onChangeFields = vi.fn();
    const hook = await renderHook((authored: WorkflowStepExecutionSelection) => useSessionAuthoringEnginePicker({ values: authored, onChangeFields, facts: {
        agentPickerContext: { machineId: 'machine-a', serverId, directory: '/repo' },
        agentTargets: [{ id: entry.backendTargetKey, label: 'Codex', target: values.agentTarget!, agentId: 'codex', pickerEntry: entry }],
    } }), { initialProps: values });
    expect(account.home.requestsFor('/v1/teams/credential-resources/entitled/discover')).toHaveLength(0);
    const detail = hook.getCurrent().options[0]?.renderDetailContent?.({ onRequestClose: () => {} });
    if (!React.isValidElement(detail)) throw new Error('missing_picker_detail');
    const screen = await renderScreen(detail);
    const testID = 'model-picker-overlay-option:' + JSON.stringify(['team_resource', 'team-b', resource.id, 1, 'brokered', agentTargetKey, 'muse-spark-1.3-contributor']);
    await vi.waitFor(() => {
        const row = screen.findByTestId(testID);
        expect(row).not.toBeNull();
        expect(row?.props.disabled).toBe(false);
    });
    onChangeFields.mockClear();
    await screen.pressByTestIdAsync(testID);
    await vi.waitFor(() => expect(onChangeFields).toHaveBeenCalled());
    const saved = WorkflowStepExecutionSelectionSchema.parse({ ...values, ...onChangeFields.mock.lastCall?.[0] });
    expect(saved.modelSelection).toBeNull();
    expect(saved.sessionConfigOptionOverrides?.overrides.reasoning_effort?.value).toBe('minimal');
    expect(saved.teamCredentialBindings).toEqual([{ v: 1, slot: { kind: 'provider_model' }, resourceId: resource.id,
        teamId: 'team-b', expectedResourceRevision: 1, deliveryMode: 'brokered', providerModelSelection: {
            agentTargetKey, modelId: 'muse-spark-1.3-contributor', application: resource.providerModels[0]!.application,
            executionMachineId: 'machine-a',
        } }]);
    await screen.unmount();
    await hook.rerender(saved);
    const reopenedDetail = hook.getCurrent().options[0]?.renderDetailContent?.({ onRequestClose: () => {} });
    if (!React.isValidElement(reopenedDetail)) throw new Error('missing_reopened_picker_detail');
    const reopened = await renderScreen(reopenedDetail);
    await vi.waitFor(() => expect(reopened.findByTestId(testID.replace('option:', 'option-selected-indicator:'))).not.toBeNull());
});
