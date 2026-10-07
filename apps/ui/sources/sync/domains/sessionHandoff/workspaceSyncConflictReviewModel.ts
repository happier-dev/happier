import { areWorkspaceSyncEntryExpectationsEqual, WorkspaceSyncConflictResolutionV1Schema, type WorkspaceSyncConflictInspectRpcResultV1, type WorkspaceSyncConflictResolutionV1, type WorkspaceSyncEntryExpectationV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { projectWorkspaceSyncConflictPages } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncConflictProjection';

export function projectLoadedWorkspaceSyncConflicts(input: Parameters<typeof projectWorkspaceSyncConflictPages>[0]) {
    return projectWorkspaceSyncConflictPages(input);
}

/** Missing is an observed deletion, never a failed or empty file read. */
export function resolveWorkspaceSyncComparisonText(input: Readonly<{
    left: WorkspaceSyncEntryExpectationV1;
    right: WorkspaceSyncEntryExpectationV1;
    leftPreview: Readonly<{ status: string; text?: string }> | null;
    rightPreview: Readonly<{ status: string; text?: string }> | null;
}>): Readonly<{ oldText: string; newText: string }> | null {
    const textFor = (entry: WorkspaceSyncEntryExpectationV1, preview: Readonly<{ status: string; text?: string }> | null): string | null => {
        if (entry.kind === 'missing') return '';
        return entry.kind === 'file' && preview?.status === 'text' && typeof preview.text === 'string'
            ? preview.text : null;
    };
    const oldText = textFor(input.left, input.leftPreview);
    const newText = textFor(input.right, input.rightPreview);
    return oldText !== null && newText !== null ? { oldText, newText } : null;
}

export function buildReviewedWorkspaceSyncResolution(input: Readonly<{
    inspection: WorkspaceSyncConflictInspectRpcResultV1;
    sourceWorkspaceRefId: string;
    selectedTargetWorkspaceRefIds: readonly string[];
    relationshipIds: readonly string[];
    strategy?: WorkspaceSyncConflictResolutionV1['strategy'];
}>): WorkspaceSyncConflictResolutionV1 | null {
    const { inspection, sourceWorkspaceRefId, selectedTargetWorkspaceRefIds, relationshipIds } = input;
    if (inspection.versions.length < 2 || relationshipIds.length === 0
        || selectedTargetWorkspaceRefIds.length === 0
        || new Set(selectedTargetWorkspaceRefIds).size !== selectedTargetWorkspaceRefIds.length) return null;
    const source = inspection.endpoints.find((endpoint) => endpoint.workspaceRefId === sourceWorkspaceRefId);
    if (source?.outcome !== 'observed' || !source.observation) return null;
    const sourceObservation = source.observation;
    const targets: Array<{ workspaceRefId: string; expected: WorkspaceSyncEntryExpectationV1 }> = [];
    for (const workspaceRefId of selectedTargetWorkspaceRefIds) {
        const endpoint = inspection.endpoints.find((candidate) => candidate.workspaceRefId === workspaceRefId);
        if (endpoint?.outcome !== 'observed' || !endpoint.observation
            || endpoint.workspaceRefId === source.workspaceRefId
            || areWorkspaceSyncEntryExpectationsEqual(endpoint.observation, sourceObservation)) return null;
        targets.push({ workspaceRefId: endpoint.workspaceRefId, expected: endpoint.observation });
    }
    if (targets.length === 0) return null;
    const base = {
        controllerMachineId: inspection.controllerMachineId,
        hubWorkspaceRefId: inspection.hubWorkspaceRefId,
        path: inspection.path,
        source: { workspaceRefId: source.workspaceRefId, expected: sourceObservation },
        targets,
        relationshipIds,
    };
    if (input.strategy === 'keep_both') {
        if (sourceObservation.kind !== 'file') return null;
        const alternatives = inspection.versions.filter((version) =>
            version.endpointWorkspaceRefIds.some((id) => selectedTargetWorkspaceRefIds.includes(id)));
        const available = alternatives.map((version) => version.entry.kind === 'file'
            ? inspection.preservationOptions?.find((option) => option.status === 'available'
                && version.endpointWorkspaceRefIds.includes(option.source.workspaceRefId)
                && areWorkspaceSyncEntryExpectationsEqual(option.source.expected, version.entry))
            : undefined);
        if (available.length === 0 || available.some((option) => !option || option.status !== 'available')) return null;
        const approvedAlternatives = available.flatMap((option) => option?.status === 'available' ? [{
            source: option.source,
            destination: option.destination,
            consequence: option.consequence,
        }] : []);
        const candidate = WorkspaceSyncConflictResolutionV1Schema.safeParse({
            ...base,
            strategy: 'keep_both',
            alternatives: approvedAlternatives,
        });
        return candidate.success ? candidate.data : null;
    }
    const candidate = WorkspaceSyncConflictResolutionV1Schema.safeParse({ ...base, strategy: 'use_source' });
    return candidate.success ? candidate.data : null;
}

export function isReviewedWorkspaceSyncResolutionCurrent(
    inspection: WorkspaceSyncConflictInspectRpcResultV1,
    reviewed: WorkspaceSyncConflictResolutionV1,
): boolean {
    const current = buildReviewedWorkspaceSyncResolution({
        inspection,
        sourceWorkspaceRefId: reviewed.source.workspaceRefId,
        selectedTargetWorkspaceRefIds: reviewed.targets.map((target) => target.workspaceRefId),
        relationshipIds: reviewed.relationshipIds,
        strategy: reviewed.strategy,
    });
    if (!current || current.controllerMachineId !== reviewed.controllerMachineId
        || current.hubWorkspaceRefId !== reviewed.hubWorkspaceRefId || current.path !== reviewed.path
        || current.targets.length !== reviewed.targets.length
        || !areWorkspaceSyncEntryExpectationsEqual(current.source.expected, reviewed.source.expected)) return false;
    const sameEntry = (left: { workspaceRefId: string; expected: WorkspaceSyncEntryExpectationV1 }, right: typeof left) =>
        left.workspaceRefId === right.workspaceRefId && areWorkspaceSyncEntryExpectationsEqual(left.expected, right.expected);
    if (!reviewed.targets.every((target) => current.targets.some((candidate) => sameEntry(candidate, target)))) return false;
    if (current.strategy !== reviewed.strategy) return false;
    if (current.strategy === 'use_source' && reviewed.strategy === 'use_source') return true;
    if (current.strategy !== 'keep_both' || reviewed.strategy !== 'keep_both'
        || current.alternatives.length !== reviewed.alternatives.length) return false;
    return reviewed.alternatives.every((alternative) => current.alternatives.some((candidate) =>
        sameEntry(candidate.source, alternative.source)
        && sameEntry(candidate.destination, alternative.destination)
        && candidate.destination.path === alternative.destination.path
        // A confirmed inclusion may become unverified, and an approved unverified link may
        // become included or excluded. A known inclusion becoming excluded, or a previously
        // excluded link becoming included, changes the approved consequence.
        && alternative.consequence.propagatingToWorkspaceRefIds.every((id) =>
            candidate.consequence.propagatingToWorkspaceRefIds.includes(id)
            || candidate.consequence.unverifiedPropagationToWorkspaceRefIds?.includes(id))
        && candidate.consequence.propagatingToWorkspaceRefIds.every((id) =>
            alternative.consequence.propagatingToWorkspaceRefIds.includes(id)
            || alternative.consequence.unverifiedPropagationToWorkspaceRefIds?.includes(id))));
}
