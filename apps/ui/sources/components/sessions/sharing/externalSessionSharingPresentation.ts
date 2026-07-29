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
        | 'import_awaiting_action_owner'
        | 'resume_awaiting_action_owner'
        | 'update_awaiting_action_owner';
    materializedThroughSourceAt: number | null;
}>;

export function resolveExternalSessionSharingPresentation(input: Readonly<{
    machineName: string | null;
    sharing: ExternalSessionTranscriptSharingDecision;
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
    if (input.sharing.kind === 'published_snapshot') {
        return {
            ...common,
            shareable: true,
            state: 'shared_snapshot_stale',
            action: 'update_awaiting_action_owner',
        };
    }
    if (input.sharing.kind === 'requires_persisted_import') {
        return {
            ...common,
            shareable: false,
            state: 'requires_persisted_import',
            action: 'import_awaiting_action_owner',
        };
    }
    if (input.sharing.kind === 'import_incomplete') {
        return {
            ...common,
            shareable: false,
            state: 'import_incomplete',
            action: 'resume_awaiting_action_owner',
        };
    }
    return {
        ...common,
        shareable: false,
        state: 'transcript_unavailable',
        action: 'none',
    };
}
