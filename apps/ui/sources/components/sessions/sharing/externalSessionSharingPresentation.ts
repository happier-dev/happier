import type { ExternalSessionOperationSharedPresentationV1 } from '@happier-dev/protocol/sessions/external/operationV1';

import { presentExternalSessionOperationShell } from '../external/progress/externalSessionOperationShellPresentation';
import type { ExternalSessionTranscriptSharingDecision } from '@/sync/runtime/external/externalSessionTranscriptAuthority';

export type ExternalSessionSharingPresentation = Readonly<{
    shareable: boolean;
    state:
        | 'hosted'
        | 'requires_persisted_import'
        | 'import_incomplete'
        | 'shared_snapshot_stale'
        | 'transcript_unavailable';
    machineName: string | null;
    action:
        | 'none'
        | 'materialize_in_flight'
        | 'import_awaiting_action_owner'
        | 'resume_awaiting_action_owner'
        | 'update_awaiting_action_owner';
    materializedThroughSourceAt: number | null;
}>;

export function resolveExternalSessionSharingPresentation(input: Readonly<{
    machineName: string | null;
    sharing: ExternalSessionTranscriptSharingDecision;
    operation?: ExternalSessionOperationSharedPresentationV1 | null;
}>): ExternalSessionSharingPresentation {
    const common = {
        machineName: input.machineName,
        materializedThroughSourceAt: input.sharing.kind === 'published_snapshot'
            ? input.sharing.materializedThroughSourceAt
            : null,
    } as const;
    if (input.sharing.kind === 'hosted') {
        return { ...common, shareable: true, state: 'hosted', action: 'none' };
    }
    const operation = presentExternalSessionOperationShell(input.operation ?? null);
    const materializing = operation.running && input.operation?.kind === 'materialize';
    if (input.sharing.kind === 'published_snapshot' || input.sharing.kind === 'requires_persisted_import') {
        const published = input.sharing.kind === 'published_snapshot';
        return {
            ...common,
            shareable: published,
            state: published ? 'shared_snapshot_stale' : 'requires_persisted_import',
            action: materializing
                ? 'materialize_in_flight'
                : operation.blocksNewOperation
                    ? 'none'
                    : published ? 'update_awaiting_action_owner' : 'import_awaiting_action_owner',
        };
    }
    if (input.sharing.kind === 'import_incomplete') {
        return {
            ...common,
            shareable: false,
            state: 'import_incomplete',
            action: materializing ? 'materialize_in_flight' : 'resume_awaiting_action_owner',
        };
    }
    return {
        ...common,
        shareable: false,
        state: 'transcript_unavailable',
        action: 'none',
    };
}
