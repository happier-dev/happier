import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from '@/components/sessions/agentInput/agentInputTestHelpers';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { WorkflowSessionAuthoringSelectionSchema } from '@happier-dev/protocol/workflows/workflowV1';

installDisconnectedServerSocketBoundary();
installAgentInputCommonModuleMocks();
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async (_request: unknown) => ({
    ok: true, result: { availableModels: [{ id: 'terra', name: 'Terra' }], supportsFreeform: false,
        runtimeDescriptorV1Accepted: true, source: 'dynamic' },
})) }));
// Machine RPC is the external boundary; picker, catalog and probe context stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async (request: { method: string; payload: unknown }) =>
        request.method === 'capabilities.invoke' ? invoke(request.payload) : {},
}));
vi.mock('expo-image', () => ({ Image: 'Image' }));

const { useSessionAuthoringEnginePicker } = await import('./useSessionAuthoringEnginePicker');
const { t } = await import('@/text');
const { getResolvedBackendCatalogEntries } = await import('@/agents/backendCatalog/getResolvedBackendCatalogEntries');
const { resetDynamicModelProbeCacheForTests } = await import('@/sync/domains/models/dynamicModelProbeCache');
const account = createProviderSettingsAccountHarness();
afterEach(async () => { await standardCleanup(); await account.reset(); });

it('honors unavailable rows and stages only the engine when choosing an existing-Session option', async () => {
    const { serverId } = await account.restore();
    const entries = getResolvedBackendCatalogEntries({ enabledAgentIds: ['codex', 'claude'] });
    const agentTargets = entries.flatMap(entry => entry.backendTarget.kind === 'agent' ? [{
        id: entry.backendTargetKey, label: entry.title, agentId: entry.agentId,
        target: entry.backendTarget, pickerEntry: entry,
    }] : []);
    const current = agentTargets.find(option => option.agentId === 'codex')!;
    const blocked = agentTargets.find(option => option.agentId === 'claude')!;
    const onChangeFields = vi.fn();
    const hook = await renderHook(() => useSessionAuthoringEnginePicker({
        values: {},
        facts: { agentTargets, agentPickerContext: { machineId: 'm1', serverId, directory: '/repo' } },
        engineOptions: [
            { id: current.id, label: current.label },
            { id: blocked.id, label: blocked.label, disabled: true, subtitle: t('workflows.input.unavailable') },
        ],
        onChangeFields,
    }));
    const picker = hook.getCurrent();
    expect(picker.options.find(option => option.id === blocked.id)).toMatchObject({
        disabled: true, subtitle: t('workflows.input.unavailable'),
    });
    picker.onSelect(blocked.id);
    expect(onChangeFields).not.toHaveBeenCalled();
    picker.onSelect(current.id);
    expect(onChangeFields).toHaveBeenCalledWith({ agentTarget: current.target,
        modelSelection: undefined, acpSessionModeId: undefined, sessionConfigOptionOverrides: undefined });
});

it.each(['same engine', 'mixed engines'] as const)('stages a model without clearing running modes or configuration for %s', async (recipients) => {
    const { serverId } = await account.restore();
    resetDynamicModelProbeCacheForTests();
    const { planExistingSessionChanges } = await import('@happier-dev/protocol/sessions/authoring/existingSessionPlanner');
    const entry = getResolvedBackendCatalogEntries({ enabledAgentIds: ['codex'] })[0]!;
    if (entry.backendTarget.kind !== 'agent') throw new Error('expected_agent_target');
    const agentTarget = entry.backendTarget;
    const onChangeFields = vi.fn();
    const hook = await renderHook(() => useSessionAuthoringEnginePicker({
        values: WorkflowSessionAuthoringSelectionSchema.parse({
            agentTarget,
            profileId: 'workflow-profile',
            runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: 'appServer' } },
            connectedServices: { v: 2, bindingsByServiceId: {
                'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'served-pool' },
            } },
        }), onChangeFields,
        facts: { agentPickerContext: { machineId: 'm1', serverId, directory: '/repo' },
            agentTargets: [{ id: entry.backendTargetKey, label: 'Codex', target: agentTarget, agentId: 'codex', pickerEntry: entry }] },
        engineOptions: [{ id: entry.backendTargetKey, label: 'Codex' }],
    }));
    const detail = hook.getCurrent().options[0]?.renderDetailContent?.({ onRequestClose: () => {} });
    if (!React.isValidElement(detail)) throw new Error('missing_picker_detail');
    const screen = await renderScreen(detail);
    const optionId = 'model-picker-overlay-option:' + JSON.stringify([entry.backendTargetKey, null, 'terra']);
    await vi.waitFor(() => expect(screen.findByTestId(optionId)).not.toBeNull());
    await screen.pressByTestIdAsync(optionId);

    const current = { address: { serverId, sessionId: 'already-codex' }, agentId: 'happier.agent.codex/codex',
        machineId: 'm1', availableModeIds: [],
        sessionConfigOptionOverrides: { v: 1 as const, updatedAt: 1, overrides: { reasoning_effort: { value: 'high', updatedAt: 1 } } } };
    const other = { ...current, address: { serverId, sessionId: 'other' },
        agentId: recipients === 'mixed engines' ? 'happier.agent.claude/claude' : current.agentId };
    expect(onChangeFields).toHaveBeenCalled();
    const plan = planExistingSessionChanges(onChangeFields.mock.lastCall?.[0], [current, other], 'Hello');
    expect(plan.stages.map(stage => stage.actionId)).toEqual(recipients === 'mixed engines'
        ? ['session.agent.transition', 'session.message.send'] : ['session.message.send']);
    expect(plan.stages.at(-1)).toMatchObject({ targets: [current.address, other.address], input: { message: 'Hello', modelOverride: 'terra' } });
});

it('offers models probed with the authored service, profile and runtime instead of Account defaults', async () => {
    const { serverId } = await account.restore();
    resetDynamicModelProbeCacheForTests();
    invoke.mockClear();
    const values = WorkflowSessionAuthoringSelectionSchema.parse({
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        profileId: 'workflow-profile',
        runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: 'appServer' } },
        connectedServices: { v: 2, bindingsByServiceId: {
            'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'served-pool' },
        } },
    });
    const entry = getResolvedBackendCatalogEntries({ enabledAgentIds: ['codex'] })[0]!;
    const hook = await renderHook(() => useSessionAuthoringEnginePicker({ values, facts: {
        agentPickerContext: { machineId: 'authored-machine', serverId, directory: '/repo' },
        agentTargets: [{ id: entry.backendTargetKey, label: 'Codex', target: values.agentTarget!, agentId: 'codex', pickerEntry: entry }],
    } }));
    expect(invoke.mock.calls).toEqual([]);
    const detail = hook.getCurrent().options[0]?.renderDetailContent?.({ onRequestClose: () => {} });
    if (!React.isValidElement(detail)) throw new Error('missing_picker_detail');
    const screen = await renderScreen(detail);
    await vi.waitFor(() => {
        const probe = invoke.mock.calls.map(([request]) => request as { method?: string; params?: unknown })
            .find(request => request.method === 'probeModels');
        expect(probe?.params).toMatchObject({ connectedServices: values.connectedServices,
            profileId: values.profileId, runtimeDescriptorV1: values.runtimeDescriptorV1 });
    });
    await vi.waitFor(() => expect(screen.findByTestId('model-picker-overlay-option:["agent:happier.agent.codex/codex",null,"terra"]')).not.toBeNull());
});

it('chooses no model while the Sessions it writes to differ, and says so on the running line (Mixed)', async () => {
    const { serverId } = await account.restore();
    resetDynamicModelProbeCacheForTests();
    const entry = getResolvedBackendCatalogEntries({ enabledAgentIds: ['codex'] })[0]!;
    const codex = { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } as const;
    const facts = { agentPickerContext: { machineId: 'm1', serverId, directory: '/repo' },
        agentTargets: [{ id: entry.backendTargetKey, label: 'Codex', target: codex, agentId: 'codex', pickerEntry: entry }] };
    const mixed = { label: 'Mixed', applyTiming: t('agentInput.model.applyTimingNextMessage') };
    const renderDetail = async (values: { agentTarget?: typeof codex }) => {
        const hook = await renderHook(() => useSessionAuthoringEnginePicker({ values, facts, onChangeFields: () => {}, mixedSelection: mixed }));
        const detail = hook.getCurrent().options[0]?.renderDetailContent?.({ onRequestClose: () => {} });
        if (!React.isValidElement(detail)) throw new Error('missing_picker_detail');
        const screen = await renderScreen(detail);
        const options = () => screen.findAll(node => typeof node.props.testID === 'string'
            && node.props.testID.startsWith('model-picker-overlay-option:'));
        await vi.waitFor(() => expect(options().length).toBeGreaterThan(0));
        // A chosen card says so to assistive tech (web aria-selected, native accessibilityState).
        const chosen = () => new Set(screen.findAll(node => node.props['aria-selected'] === true
            || node.props.accessibilityState?.selected === true).map(node => String(node.props.id ?? node.props.testID ?? node.props.accessibilityLabel)));
        return { screen, chosen };
    };
    const unstaged = await renderDetail({});
    expect(unstaged.chosen().size).toBe(0);
    expect(unstaged.screen.getTextContent()).toContain(`${t('agentInput.model.running', { model: 'Mixed' })} · ${mixed.applyTiming}`);
    // Once an Agent is staged the pane shows that choice, as every other host does.
    const staged = await renderDetail({ agentTarget: codex });
    expect(staged.chosen().size).toBeGreaterThan(0);
});
