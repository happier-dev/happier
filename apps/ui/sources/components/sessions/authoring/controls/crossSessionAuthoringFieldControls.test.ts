import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { useCrossSessionAuthoringFieldControl } from './useCrossSessionAuthoringFieldControl';
import { AgentExecutionTargetV1Schema, CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { MAX_AGENT_ROUTING_ID_BYTES } from '@happier-dev/protocol/agents/agentIdV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { buildAcpConfigOptionOverridesV1 } from '@happier-dev/protocol/sessions/metadata/overrides';
import type { SessionAuthoringControls } from './useSessionAuthoringControls';
import { buildSessionModelSelectionForAgentTarget } from '../sessionModelSelectionValue';
import { describeEffectiveModelMode } from '@/sync/domains/models/describeEffectiveModelMode';
import { resolveCrossSessionAuthoringFieldControl } from './crossSessionAuthoringFieldControls';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: key => key });
});

const claude = AgentExecutionTargetV1Schema.parse({ kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } });
const codex = AgentExecutionTargetV1Schema.parse({ kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } });
const agentTargets = [
    { id: 'claude', label: 'Claude', agentId: 'claude', target: claude },
    { id: 'codex', label: 'Codex', agentId: 'codex', target: codex },
];

function controls(): SessionAuthoringControls {
    return {
        modelOptions: [{ value: 'default', label: 'Default' }, { value: 'model-a', label: 'Model A' }],
        permissionModeOptions: [
            { value: 'default', label: 'Default', description: '', icon: 'shield' },
            { value: 'read-only', label: 'Read only', description: '', icon: 'eye' },
        ],
        permissionModeOrder: ['default', 'read-only'],
        effectivePermissionPolicy: { effectiveMode: 'default', reasons: [], notes: [] },
        effectivePermissionLabel: 'Default', permissionChipLabel: 'Default',
        effectiveModelPolicy: describeEffectiveModelMode({ agentType: 'claude', selectedModelId: null, metadata: null }),
        selectedModelLabel: null, appliedModelPresentation: null, modelApplyTiming: '', modelNotes: [],
        canEnterCustomModel: false, shouldShowModelOptionDescriptions: false, selectedModelForControls: null,
        selectedModelOptionControls: null, selectedEffortLabel: null,
        acpConfigOptionControls: [{
            option: { id: 'effort', name: 'Effort', type: 'select', currentValue: 'low', options: [
                { value: 'low', name: 'Low' }, { value: 'high', name: 'High' },
            ] }, effectiveValue: 'low', isPending: false,
        }],
        sessionModeChipControl: null, sessionModePickerOptions: [], shouldRenderSessionModeChip: false,
        sessionModeChipPresentation: null, sessionModeChipInteraction: null,
    };
}

const target = (agentTarget = claude, permissionMode: 'default' | 'read-only' = 'default') => ({
    agentId: agentTarget.identity.localId, values: { agentTarget, permissionMode },
    controls: controls(), facts: { agentTargets },
});
const base = { targets: [target(), target(codex, 'read-only')], agentSwitchingEnabled: true, mixedLabel: 'Mixed' };

describe('Session-specific field intersection', () => {
    it('offers configured switches the transition can represent and disables an unrepresentable switch', () => {
        const options = ['review-bot', 'b'.repeat(MAX_AGENT_ROUTING_ID_BYTES)].map(definitionId => {
            const agentTarget = AgentExecutionTargetV1Schema.parse({
                kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId,
            });
            return { id: buildBackendTargetKeyV2(agentTarget), label: definitionId,
                agentId: 'custom-acp', target: agentTarget };
        });
        const facts = { agentTargets: options };
        const current = { ...target(options[1]!.target), facts };
        const switches = resolveCrossSessionAuthoringFieldControl({ ...base, field: 'agentTarget',
            targets: [{ ...target(), facts }] });
        expect(switches).toMatchObject({ kind: 'options', options: [
            { id: options[0]!.id },
            { id: options[1]!.id, disabled: true, subtitle: 'workflows.input.unavailable' },
        ] });
        if (switches.kind !== 'options') throw new Error('Expected engine options');
        expect(switches.options[0]?.disabled).toBeUndefined();
        const unchanged = resolveCrossSessionAuthoringFieldControl({ ...base, field: 'agentTarget', targets: [current] });
        expect(unchanged).toMatchObject({ kind: 'options', selectedOptionId: options[1]!.id, options: [
            { id: options[0]!.id, disabled: true },
            { id: options[1]!.id, preserveCurrentFields: true },
        ] });
        if (unchanged.kind !== 'options') throw new Error('Current engine must be selectable');
        expect(unchanged.options[1]?.disabled).toBeUndefined();
    });

    it('keeps separately configured ACP engines distinct even when they share one runtime Agent', () => {
        const options = ['codex', 'other'].map(definitionId => {
            const agentTarget = AgentExecutionTargetV1Schema.parse({
                kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId,
            });
            return { id: buildBackendTargetKeyV2(agentTarget), label: definitionId,
                agentId: 'custom-acp', target: agentTarget };
        });
        const targets = options.map(option => ({ ...target(option.target), agentId: option.agentId,
            facts: { agentTargets: options } }));
        expect(resolveCrossSessionAuthoringFieldControl({ ...base, targets, field: 'agentTarget' }))
            .toMatchObject({ kind: 'options', unselectedLabel: 'Mixed' });
        expect(resolveCrossSessionAuthoringFieldControl({ ...base, targets, field: 'modelSelection' }))
            .toMatchObject({ kind: 'unavailable', reason: 'requires_agent_target' });
    });

    it('intersects permissions and shows Mixed through the existing label prop', () => {
        const targets = [target(), { ...target(codex, 'read-only'), controls: { ...controls(), permissionModeOptions: [controls().permissionModeOptions[0]!] } }];
        expect(resolveCrossSessionAuthoringFieldControl({ ...base, targets, field: 'permissionMode' }))
            .toMatchObject({ kind: 'options', options: [{ id: 'default' }], unselectedLabel: 'Mixed' });
        expect(resolveCrossSessionAuthoringFieldControl({ ...base, targets, field: 'permissionMode', selection: { permissionMode: 'default' } }))
            .toMatchObject({ kind: 'options', selectedOptionId: 'default' });
    });
    it('requires one engine for Agent-bound controls and honors the existing engine gate', () => {
        for (const field of ['modelSelection', 'sessionConfigOptionOverrides', 'connectedServices'] as const) {
            expect(resolveCrossSessionAuthoringFieldControl({ ...base, field })).toMatchObject({ kind: 'unavailable', reason: 'requires_agent_target' });
        }
        expect(resolveCrossSessionAuthoringFieldControl({ ...base, field: 'agentTarget' })).toMatchObject({ kind: 'options', unselectedLabel: 'Mixed' });
        expect(resolveCrossSessionAuthoringFieldControl({ ...base, field: 'agentTarget', agentSwitchingEnabled: false })).toMatchObject({ kind: 'unavailable', reason: 'feature_disabled' });
    });
    it('keeps distinct catalogs for two Sessions with the same effective Agent, including a pending switch', () => {
        const targets = [target(), { ...target(), controls: { ...controls(), modelOptions: [{ value: 'model-a', label: 'Model A' }] } }];
        expect(resolveCrossSessionAuthoringFieldControl({ ...base, targets, field: 'modelSelection' })).toMatchObject({ kind: 'options', options: [{ id: 'model-a' }] });
        expect(resolveCrossSessionAuthoringFieldControl({ ...base, targets, field: 'modelSelection', selection: { agentTarget: claude } })).toMatchObject({ kind: 'options', options: [{ id: 'model-a' }] });
    });
    it('ignores observation clocks and marks only differing config groups Mixed', () => {
        const targets = ['low', 'high'].map((value, index) => ({ ...target(), values: {
            agentTarget: claude,
            modelSelection: buildSessionModelSelectionForAgentTarget({ agentTarget: claude, modelId: 'model-a', updatedAt: index + 1 }),
            sessionConfigOptionOverrides: buildAcpConfigOptionOverridesV1({ updatedAt: index + 1, overrides: { effort: { value, updatedAt: index + 1 } } }),
        } }));
        expect(resolveCrossSessionAuthoringFieldControl({ ...base, targets, field: 'modelSelection' })).toMatchObject({ kind: 'options', selectedOptionId: 'model-a' });
        expect(resolveCrossSessionAuthoringFieldControl({ ...base, targets, field: 'sessionConfigOptionOverrides' })).toMatchObject({ kind: 'optionGroups', groups: [{ id: 'effort', unselectedLabel: 'Mixed' }] });
        expect(resolveCrossSessionAuthoringFieldControl({ ...base, targets, field: 'sessionConfigOptionOverrides', selection: { sessionConfigOptionOverrides: buildAcpConfigOptionOverridesV1({ updatedAt: 3, overrides: { effort: { value: 'high', updatedAt: 3 } } }) } })).toMatchObject({ kind: 'optionGroups', groups: [{ id: 'effort', selectedOptionId: 'high' }] });
    });
    it('never displays the empty-id mode option as a mixed selection', () => {
        const targets = ['', 'plan'].map(mode => ({ ...target(), values: { agentTarget: claude, acpSessionModeId: mode },
            controls: { ...controls(), shouldRenderSessionModeChip: true, sessionModePickerOptions: [{ id: '', label: 'Default' }, { id: 'plan', label: 'Plan' }] } }));
        const model = resolveCrossSessionAuthoringFieldControl({ ...base, targets, field: 'acpSessionModeId' });
        expect(model).toMatchObject({ kind: 'options', unselectedLabel: 'Mixed' });
        if (model.kind !== 'options') throw new Error('expected mode options');
        expect(model.options.some(option => option.id === model.selectedOptionId)).toBe(false);
    });
    it('offers Skills/MCP for one Machine scope even when selections differ, and says when Machines differ', () => {
        const scoped = (machineId: string, directory: string, skills: string[] = []) => ({ ...target(),
            facts: { agentTargets, agentPickerContext: { machineId, serverId: 'home', directory: null }, machineName: 'devbox' },
            directory, values: { agentTarget: claude, capabilitySelection: skills.length
                ? { skills: { v: 1 as const, forceIncludeSkillIds: skills, forceExcludeSkillIds: [], excludeNativeSkillNames: [] } } : null } });
        expect(resolveCrossSessionAuthoringFieldControl({ ...base, field: 'capabilitySelection',
            targets: [scoped('m1', '/repo/a'), scoped('m1', '/repo/b')] }))
            .toMatchObject({ kind: 'mcp', agentId: 'claude', context: { machineId: 'm1', directory: '/repo/a', machineName: 'devbox' } });
        // Differing selections stay editable: item edits keep each target's other overrides.
        const differing = [scoped('m1', '/repo/a', ['pdf']), scoped('m1', '/repo/b')];
        expect(resolveCrossSessionAuthoringFieldControl({ ...base, field: 'capabilitySelection', targets: differing }))
            .toMatchObject({ kind: 'mcp', context: { machineId: 'm1', serverId: 'home' } });
        expect(resolveCrossSessionAuthoringFieldControl({ ...base, field: 'capabilitySelection',
            targets: [scoped('m1', '/repo/a'), scoped('m2', '/repo/a')] }))
            .toMatchObject({ kind: 'unavailable', reason: 'differs_between_targets' });
    });
    it('preserves owner refusals and refuses new-session fields and empty intersections', () => {
        expect(resolveCrossSessionAuthoringFieldControl({ ...base, field: 'profileId' })).toMatchObject({ kind: 'unavailable', reason: 'not_supported_on_target' });
        expect(resolveCrossSessionAuthoringFieldControl({ ...base, field: 'permissionMode', targets: [{ ...target(), controls: { ...controls(), permissionModeOptions: [] } }] })).toMatchObject({ kind: 'unavailable', reason: 'agent_has_no_options' });
        expect(resolveCrossSessionAuthoringFieldControl({ ...base, field: 'modelSelection', targets: [target(), { ...target(), controls: { ...controls(), modelOptions: [{ value: 'other', label: 'Other' }] } }] })).toMatchObject({ kind: 'unavailable', reason: 'not_supported_on_target' });
    });
});

it('runs one intersection pass per authoring change and zero passes on 50 unrelated arrivals', async () => {
    const first = target();
    let reads = 0;
    const permissions = first.controls.permissionModeOptions;
    Object.defineProperty(first.controls, 'permissionModeOptions', { get() { reads++; return permissions; } });
    let targets = Array.from({ length: 50 }, () => first);
    const mounted = await renderHook(() => useCrossSessionAuthoringFieldControl({ ...base, targets, field: 'permissionMode' }));
    try {
        const initial = mounted.getCurrent();
        const perPass = reads;
        expect(perPass).toBeGreaterThan(0);
        for (let index = 0; index < 50; index++) await mounted.rerender();
        expect(reads).toBe(perPass);
        expect(mounted.getCurrent()).toBe(initial);
        targets = targets.map(value => ({ ...value, values: { ...value.values, permissionMode: 'read-only' } }));
        await mounted.rerender();
        expect(reads).toBe(perPass * 2);
        expect(mounted.getCurrent()).toMatchObject({ selectedOptionId: 'read-only' });
    } finally { await mounted.unmount(); }
});
