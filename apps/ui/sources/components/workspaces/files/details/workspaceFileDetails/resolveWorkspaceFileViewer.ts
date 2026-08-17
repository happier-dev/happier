import {
    compareOpenableContentViewerMatchesV1,
    matchOpenableContentViewerV1,
    normalizeOpenableContentPreferenceSelectorV1,
    serializeOpenableContentPreferenceSelectorV1,
} from '@happier-dev/protocol';
import type {
    OpenableContentMetadataV1,
    OpenableContentPreferenceSelectorV1,
    OpenableContentViewerMatchV1,
    PluginContributionIdentityV1,
    WorkspaceFileViewerPreferencesV1,
} from '@happier-dev/protocol';
import {
    isPluginUiDestinationBindingAdmittedAtRuntimeV1,
    type PluginUiDestinationRuntimeFormFactorV1,
    type PluginUiPlatformV1,
    type PluginUiTargetKindV1,
} from '@happier-dev/protocol/plugins/ui';

import {
    canRenderPluginUiProjectionEntry,
    type PluginUiPolicyEvaluationContext,
} from '@/sync/domains/plugins/ui/policy';
import type {
    PluginUiOpenableContentViewerProjection,
    PluginUiProjectionModel,
    PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';
import {
    readPluginUiContributionOrigin,
    type PluginUiContributionOriginV1,
} from '@/sync/domains/plugins/ui/projectionUnion';
import { selectPluginSurfacePlacementsByDestination } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';

export type WorkspaceFileViewerCandidate = Readonly<{
    entry: PluginUiOpenableContentViewerProjection;
    placement: PluginUiSurfacePlacementProjection;
}>;

export type WorkspaceFileViewerMatch = Readonly<{
    candidate: WorkspaceFileViewerCandidate;
    identity: PluginContributionIdentityV1;
    match: OpenableContentViewerMatchV1;
}>;

export type WorkspaceFileViewerSelection = Readonly<{ kind: 'builtin' }> | Readonly<{
    kind: 'plugin';
    candidate: WorkspaceFileViewerMatch;
}>;

export type WorkspaceFileViewerUnavailablePreference = Readonly<{
    pluginId: string;
    contributionLocalId: string;
}>;

/** The host-owned details picker never renders more than eight candidates. */
export const MAX_WORKSPACE_FILE_VIEWER_CHOICES = 8;

/**
 * A built-in editor owns its file tab, including the first render that will
 * hydrate a persisted editor draft. An openable-content viewer is therefore
 * only eligible outside both editor states.
 */
export function isWorkspaceFileOpenableContentViewerEligible(input: Readonly<{
    isEditingFile: boolean;
    hasPersistedEditingDraft: boolean;
}>): boolean {
    return !input.isEditingFile && !input.hasPersistedEditingDraft;
}

export type WorkspaceFileViewerChoice = Readonly<{ kind: 'builtin' }> | Readonly<{
    kind: 'plugin';
    candidate: WorkspaceFileViewerMatch;
}> | Readonly<{
    kind: 'unavailable';
    preference: WorkspaceFileViewerUnavailablePreference;
}>;

/**
 * The bounded host-owned choice data rendered in the current details chrome.
 * Display metadata still belongs to the destination projection; this model
 * contains only the built-in candidate, SDK-matched plugin identities, and
 * the canonical Settings selector for the current host metadata.
 */
export type WorkspaceFileViewerChoiceModel = Readonly<{
    choices: readonly WorkspaceFileViewerChoice[];
    preferenceSelector: OpenableContentPreferenceSelectorV1;
    selected: WorkspaceFileViewerSelection;
    /** Retained Settings intent that has no currently matching mount. */
    unavailablePreference?: WorkspaceFileViewerUnavailablePreference;
}>;

/**
 * Joins a daemon-projected viewer to its one current details destination.
 * Declarations never mount from their own map: the placement remains the
 * availability and host-origin owner, and ambiguity fails closed.
 */
export function resolveWorkspaceFileViewerCandidates(input: Readonly<{
    projection: PluginUiProjectionModel;
    targetKind: Extract<PluginUiTargetKindV1, 'session' | 'project'>;
    /** Current host facts; file details must not advertise an unmountable viewer. */
    platform: PluginUiPlatformV1;
    formFactor: PluginUiDestinationRuntimeFormFactorV1;
    policyContext?: PluginUiPolicyEvaluationContext;
}>): readonly WorkspaceFileViewerCandidate[] {
    const candidates = Object.values(input.projection.openableContentViewersById)
        .flatMap<WorkspaceFileViewerCandidate>((entry) => {
            const placements = selectPluginSurfacePlacementsByDestination(input.projection, entry.destination)
                .filter((placement) => (
                placement.binding.container === 'detailsTab'
                && placement.binding.targetKind === input.targetKind
                && isPluginUiDestinationBindingAdmittedAtRuntimeV1({
                    binding: placement.binding,
                    platform: input.platform,
                    formFactor: input.formFactor,
                })
                // Manifest admission rejects multiple-instance viewer
                // destinations. Retain this projection-boundary defense so a
                // stale or malformed daemon projection cannot mount one.
                && placement.binding.instancePolicy === 'singleton'
            ));
            if (placements.length !== 1) return [];
            const placement = placements[0]!;
            if (
                placement.availability.state !== 'available'
                || !canRenderPluginUiProjectionEntry(placement, input.policyContext)
                || !haveSameHostOrigin(entry, placement)
            ) {
                return [];
            }
            return [{ entry, placement }];
        })
        .sort((left, right) => left.entry.id.localeCompare(right.entry.id));
    return Object.freeze(candidates);
}

/**
 * UI-FILE-OPENER-V1 selection belongs with the shared built-in
 * file-details owner. The plugin registry supplies only currently mountable
 * candidates; Settings and Protocol retain their own persistence/matching
 * authority.
 */
export function resolveWorkspaceFileViewer(input: Readonly<{
    metadata: OpenableContentMetadataV1;
    preferences: WorkspaceFileViewerPreferencesV1;
    availablePluginViewers: readonly WorkspaceFileViewerCandidate[];
}>): WorkspaceFileViewerSelection {
    return resolveWorkspaceFileViewerChoiceModel(input).selected;
}

export function resolveWorkspaceFileViewerChoiceModel(input: Readonly<{
    metadata: OpenableContentMetadataV1;
    preferences: WorkspaceFileViewerPreferencesV1;
    availablePluginViewers: readonly WorkspaceFileViewerCandidate[];
}>): WorkspaceFileViewerChoiceModel {
    const matchingCandidates = input.availablePluginViewers
        .flatMap<WorkspaceFileViewerMatch>((candidate) => {
            const match = matchOpenableContentViewerV1({
                id: candidate.entry.identity.localId,
                destination: candidate.entry.destination.localId,
                ...candidate.entry.viewer,
            }, input.metadata);
            return match === null ? [] : [{ candidate, identity: candidate.entry.identity, match }];
        })
        .sort(compareOpenableContentViewerMatchesV1);
    const preferenceSelectors = derivePreferenceSelectors(input.metadata);
    const preferenceSelector: OpenableContentPreferenceSelectorV1 = preferenceSelectors[0]
        ?? { kind: 'class', value: input.metadata.contentClass };
    const createModel = (
        selected: WorkspaceFileViewerSelection,
        unavailablePreference?: WorkspaceFileViewerUnavailablePreference,
    ): WorkspaceFileViewerChoiceModel => Object.freeze({
        choices: buildWorkspaceFileViewerChoices({
            matchingCandidates,
            selected,
            unavailablePreference,
        }),
        preferenceSelector,
        selected,
        ...(unavailablePreference === undefined ? {} : { unavailablePreference }),
    });

    for (const selector of preferenceSelectors) {
        const preferred = input.preferences.selections[serializeOpenableContentPreferenceSelectorV1(selector)];
        if (!preferred) continue;
        if (preferred.kind === 'builtin') {
            return createModel({ kind: 'builtin' });
        }

        const candidate = matchingCandidates.find((entry) => (
            entry.identity.pluginId === preferred.pluginId
            && entry.identity.localId === preferred.contributionLocalId
        ));
        // Settings deliberately preserves the unavailable qualified identity.
        // This owner renders the built-in view until the exact match returns.
        return candidate
            ? createModel({ kind: 'plugin', candidate })
            : createModel(
                { kind: 'builtin' },
                {
                    pluginId: preferred.pluginId,
                    contributionLocalId: preferred.contributionLocalId,
                },
            );
    }

    // A matching declaration makes a plugin a choice, not the default owner
    // of file content. Only an explicit Settings-owned qualified preference
    // may mount a plugin viewer; this keeps the built-in viewer recoverable
    // across install order and temporary plugin availability changes.
    return createModel({ kind: 'builtin' });
}

function buildWorkspaceFileViewerChoices(input: Readonly<{
    matchingCandidates: readonly WorkspaceFileViewerMatch[];
    selected: WorkspaceFileViewerSelection;
    unavailablePreference?: WorkspaceFileViewerUnavailablePreference;
}>): readonly WorkspaceFileViewerChoice[] {
    const choices: WorkspaceFileViewerChoice[] = [{ kind: 'builtin' }];
    if (input.unavailablePreference) {
        choices.push({ kind: 'unavailable', preference: input.unavailablePreference });
    }
    const selectedCandidate = input.selected.kind === 'plugin' ? input.selected.candidate : null;
    const candidates = selectedCandidate === null
        ? input.matchingCandidates
        : [
            selectedCandidate,
            ...input.matchingCandidates.filter((candidate) => !isSameWorkspaceFileViewerCandidate(candidate, selectedCandidate)),
        ];
    for (const candidate of candidates) {
        if (choices.length >= MAX_WORKSPACE_FILE_VIEWER_CHOICES) break;
        choices.push({ kind: 'plugin', candidate });
    }
    return Object.freeze(choices);
}

function isSameWorkspaceFileViewerCandidate(
    left: WorkspaceFileViewerMatch,
    right: WorkspaceFileViewerMatch,
): boolean {
    return left.identity.pluginId === right.identity.pluginId
        && left.identity.localId === right.identity.localId;
}

function haveSameHostOrigin(
    entry: PluginUiOpenableContentViewerProjection,
    placement: PluginUiSurfacePlacementProjection,
): boolean {
    const viewerOrigin = readPluginUiContributionOrigin(entry);
    const placementOrigin = readPluginUiContributionOrigin(placement);
    if (viewerOrigin === null && placementOrigin === null) return true;
    if (viewerOrigin === null || placementOrigin === null) return false;
    if (viewerOrigin.executionOrigin === null || placementOrigin.executionOrigin === null) return false;
    return haveSameOrigin(viewerOrigin, placementOrigin);
}

function haveSameOrigin(
    left: PluginUiContributionOriginV1,
    right: PluginUiContributionOriginV1,
): boolean {
    const leftExecutionOrigin = left.executionOrigin;
    const rightExecutionOrigin = right.executionOrigin;
    return left.machineId === right.machineId
        && left.serverId === right.serverId
        && left.generation === right.generation
        && left.interactionEnabled === right.interactionEnabled
        && leftExecutionOrigin?.serverIdentityId === rightExecutionOrigin?.serverIdentityId
        && leftExecutionOrigin?.materializationRef.pluginId === rightExecutionOrigin?.materializationRef.pluginId
        && leftExecutionOrigin?.materializationRef.machineId === rightExecutionOrigin?.materializationRef.machineId
        && leftExecutionOrigin?.materializationRef.materializationId === rightExecutionOrigin?.materializationRef.materializationId;
}

function derivePreferenceSelectors(metadata: OpenableContentMetadataV1): readonly OpenableContentPreferenceSelectorV1[] {
    const candidateInputs: readonly unknown[] = [
        ...(metadata.mimeType === undefined ? [] : [{ kind: 'mime', value: metadata.mimeType }]),
        ...(metadata.extension === undefined ? [] : [{ kind: 'extension', value: metadata.extension }]),
        { kind: 'class', value: metadata.contentClass },
    ];
    const selectors: OpenableContentPreferenceSelectorV1[] = [];

    for (const candidate of candidateInputs) {
        try {
            selectors.push(normalizeOpenableContentPreferenceSelectorV1(candidate));
        } catch {
            // Host stat metadata is canonical in production. Ignore malformed
            // candidates defensively so an invalid optional field cannot defeat
            // a valid lower-specificity preference or the built-in fallback.
        }
    }
    return selectors;
}
