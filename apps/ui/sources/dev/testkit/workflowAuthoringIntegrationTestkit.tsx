import { WorkflowStepExecutionSelectionSchema, type WorkflowStepExecutionSelection } from '@happier-dev/protocol/workflows/workflowV1';
import type { TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol/teams';

type ModelRow = Readonly<{ disabled: boolean; selected: boolean }>;

export async function readUiBundledClaudeDeclaration() {
    const { getBundledAgentDeclaration } = await import('@/agents/catalog/catalog');
    const declaration = getBundledAgentDeclaration('claude');
    if (!declaration?.providerRequirements) throw new Error('Bundled Claude provider requirements are unavailable');
    return { identity: declaration.identity, acceptsProtocols: declaration.providerRequirements.acceptsProtocols };
}

/** Mount the shared authoring picker after the journey restores its real UI Account. */
export async function mountUiWorkflowEnginePicker(params: Readonly<{
    serverId: string;
    machineId: string;
    directory: string;
    values: WorkflowStepExecutionSelection;
}>) {
    // Keep the UI graph lazy: the composed caller installs its actual Home/Socket boundary first.
    const [React, { renderHook }, { renderScreen }, { waitForTestEvent },
        { useSessionAuthoringEnginePicker }, { getResolvedBackendCatalogEntries },
        { resolveBundledAgentIdFromContributionIdentity }, { buildBackendTargetKeyV2 },
        { sessionModelSelectionKey }] = await Promise.all([
        import('react'), import('./hooks/renderHook'), import('./render/renderScreen'), import('./hooks/waitForTestEvent'),
        import('@/components/sessions/authoring/controls/useSessionAuthoringEnginePicker'),
        import('@/agents/backendCatalog/getResolvedBackendCatalogEntries'), import('@/agents/catalog/catalog'),
        import('@happier-dev/protocol/backends/targets/backendTargetRefV2'),
        import('@/components/sessions/modelPicker/sessionModelSelectionKey'),
    ]);
    const target = params.values.agentTarget;
    const agentId = target?.kind === 'agent' ? resolveBundledAgentIdFromContributionIdentity(target.identity) : null;
    if (!target || !agentId) throw new Error('Workflow picker journey requires a bundled Agent target');
    const entry = getResolvedBackendCatalogEntries({ enabledAgentIds: [agentId] })
        .find(candidate => candidate.backendTargetKey === buildBackendTargetKeyV2(target));
    if (!entry) throw new Error('Workflow picker Agent is absent from the canonical backend catalog');
    let values = params.values;
    let changed = false;
    const hook = await renderHook((authored: WorkflowStepExecutionSelection) => useSessionAuthoringEnginePicker({
        values: authored,
        onChangeFields: fields => {
            values = WorkflowStepExecutionSelectionSchema.parse({ ...values, ...fields });
            changed = true;
        },
        facts: {
            agentPickerContext: { machineId: params.machineId, serverId: params.serverId, directory: params.directory },
            agentTargets: [{ id: entry.backendTargetKey, label: entry.title, target, agentId, pickerEntry: entry }],
        },
    }), { initialProps: values });
    const detailElement = () => {
        const picker = hook.getCurrent();
        const detail = picker.options.find(option => option.id === entry.backendTargetKey)
            ?.renderDetailContent?.({ onRequestClose: () => {} });
        if (!React.isValidElement(detail)) throw new Error('Workflow picker did not render its Agent detail');
        return detail;
    };
    let screen: Awaited<ReturnType<typeof renderScreen>>;
    try {
        screen = await renderScreen(detailElement());
    } catch (error) {
        await hook.unmount();
        throw error;
    }
    const rowId = (selection: TeamCredentialProviderModelSelectionV1) =>
        `model-picker-overlay-option:${sessionModelSelectionKey(selection)}`;
    const readModelRow = (selection: TeamCredentialProviderModelSelectionV1): ModelRow | null => {
        const row = screen.findHostByTestId(rowId(selection));
        if (!row) return null;
        return {
            disabled: Boolean(row.props.disabled),
            selected: screen.findByTestId(`model-picker-overlay-option-selected-indicator:${sessionModelSelectionKey(selection)}`) !== null,
        };
    };
    const waitForModelRow = async (selection: TeamCredentialProviderModelSelectionV1, expected?: Readonly<{ selected?: boolean }>): Promise<ModelRow> => {
        await waitForTestEvent(screen.subscribe, () => readModelRow(selection), row =>
            row !== null && !row.disabled && (expected?.selected === undefined || row.selected === expected.selected));
        const row = readModelRow(selection);
        if (!row) throw new Error('Workflow model row disappeared after publication');
        return row;
    };
    return {
        waitForModelRow,
        async chooseModel(selection: TeamCredentialProviderModelSelectionV1): Promise<WorkflowStepExecutionSelection> {
            await waitForModelRow(selection);
            changed = false;
            await screen.pressByTestIdAsync(rowId(selection));
            if (!changed) throw new Error('Workflow model press did not publish authoring fields');
            await hook.rerender(values);
            await screen.update(detailElement());
            return values;
        },
        async reopen(saved: WorkflowStepExecutionSelection): Promise<void> {
            await screen.unmount();
            values = saved;
            await hook.rerender(values);
            screen = await renderScreen(detailElement());
        },
        async close(): Promise<void> {
            try { await screen.unmount(); } finally { await hook.unmount(); }
        },
    };
}
