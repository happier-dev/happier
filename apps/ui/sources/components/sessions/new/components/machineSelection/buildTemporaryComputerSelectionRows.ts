import type { RunnerArtifactTarget } from '@happier-dev/protocol/ephemeralRunner/runnerArtifact';
import type { SessionAuthoringExecutionTargetV2 } from '@happier-dev/protocol/sessions/authoring/fieldCatalog';

import {
    resolveTemporaryComputerDestinationProjectionState,
    type TemporaryComputerAvailability,
} from '@/components/sessions/new/hooks/useTemporaryComputerAvailability';
import type { TemporaryComputerSelection } from './useMachineSelectionListModel';

type TemporaryComputerAuthoringTarget = Extract<
    SessionAuthoringExecutionTargetV2,
    { kind: 'temporary_computer' }
>;

type TemporaryComputerWorkspace = TemporaryComputerAuthoringTarget['workspace'];

/**
 * The one owner of the Temporary-computer rows in the `Run on` list.
 *
 * Both the popover picker and the full-screen picker consume it. Only exact
 * platform artifacts positively projected by the authenticated Home are ever
 * selectable. A pending or transiently failed projection retains one disabled,
 * explanatory row (and its existing retry); positively absent capability or
 * publication remains omitted. Launch readiness stays a separate explanation
 * on a genuinely published destination.
 */
export function buildTemporaryComputerSelectionRows(input: Readonly<{
    serverId: string | null;
    availability: TemporaryComputerAvailability;
    /** The draft's committed target, used only when it belongs to this exact Home. */
    selectedTarget: TemporaryComputerAuthoringTarget | null;
    /** Exact recovery copy while the destination is eligible but the launch is blocked. */
    launchBlockText: string | null;
    /** Exact reason copy while the destination itself cannot be offered. */
    unavailableText: string | null;
    onSelect: (
        artifactTarget: RunnerArtifactTarget,
        workspace: TemporaryComputerWorkspace,
        packageExpiresAt: number | undefined,
    ) => void;
    /** Overrides the availability owner's retry for a retained-but-unpublished platform. */
    retry?: () => void;
}>): readonly TemporaryComputerSelection[] {
    const serverId = input.serverId;
    if (!serverId) return [];
    const selected = input.selectedTarget?.serverId === serverId ? input.selectedTarget : null;

    if (input.availability.status !== 'available') {
        if (resolveTemporaryComputerDestinationProjectionState(input.availability) === 'empty') return [];
        return [{
            serverId,
            artifactTarget: selected?.artifactTarget ?? null,
            selected: selected !== null,
            workspace: selected?.workspace ?? null,
            ...(selected?.packageExpiresAt !== undefined
                ? { packageExpiresAt: selected.packageExpiresAt }
                : {}),
            disabled: true,
            ...(input.unavailableText ? { unavailableText: input.unavailableText } : {}),
            ...(input.availability.status === 'unavailable'
                ? { onRetry: input.retry ?? input.availability.retry }
                : {}),
            // This explanatory row has no open step while its publication
            // authority is unresolved. The required callback is therefore
            // deliberately inert instead of fabricating an artifact target.
            onSelect: () => undefined,
        }];
    }
    if (input.availability.artifacts.length === 0) return [];

    const rows: TemporaryComputerSelection[] = input.availability.artifacts.map((artifact) => ({
        serverId,
        artifactTarget: artifact.identity.target,
        selected: selected?.artifactTarget === artifact.identity.target,
        workspace: selected?.artifactTarget === artifact.identity.target ? selected.workspace : null,
        ...(selected?.artifactTarget === artifact.identity.target && selected.packageExpiresAt !== undefined
            ? { packageExpiresAt: selected.packageExpiresAt }
            : {}),
        // A launch block explains itself on a still-selectable destination: the
        // user may legitimately choose it and then fix the model selection.
        ...(input.launchBlockText ? { unavailableText: input.launchBlockText } : {}),
        onSelect: (workspace, packageExpiresAt) => input.onSelect(artifact.identity.target, workspace, packageExpiresAt),
    }));

    return rows;
}
