import {
    isExactPluginMachineMaterializationRefV1,
    isPluginMachineMaterializationOnServerIdentityV1,
    type PluginMachineExecutionOriginV1,
    type PluginMachineMaterializationV1,
} from '@happier-dev/protocol';

import type { ServerMachineInventorySnapshotV1 } from '@/sync/domains/machines/machineInventorySnapshots';
import { resolveMachinePickerPresence } from '@/sync/domains/machines/identity/resolveMachinePickerPresence';

export type PluginMachineOriginRejectionReasonV1 =
    | 'content_conflict'
    | 'disabled'
    | 'incompatible'
    | 'machine_local'
    | 'missing'
    | 'offline'
    | 'plugin_mismatch'
    | 'replaced'
    | 'revoked'
    | 'stale'
    | 'untrusted'
    | 'unknown';

export type PluginMachineExecutionOriginCandidateV1 = Readonly<{
    /** Uncollapsed fact supplied by the Artifact owner. */
    materialization: PluginMachineMaterializationV1;
    /** Artifact-owned immutable release-fact comparison result. */
    releaseContent: 'matched' | 'conflict' | 'unknown';
    /** Result of Artifact-owned currentness/release/compatibility validation. */
    validation:
        | Readonly<{ kind: 'admitted' }>
        | Readonly<{ kind: 'rejected'; reason: PluginMachineOriginRejectionReasonV1 }>;
}>;

export type PluginMachineReleaseClassificationV1 = Pick<
    PluginMachineExecutionOriginCandidateV1,
    'releaseContent' | 'validation'
>;

function resolveMachineMaterializationRejection(params: Readonly<{
    materialization: PluginMachineMaterializationV1;
    machineSnapshots: readonly ServerMachineInventorySnapshotV1[];
}>): PluginMachineOriginRejectionReasonV1 | null {
    const snapshot = params.machineSnapshots.find((candidate) => (
        candidate.kind === 'resolved'
        && candidate.serverIdentityId === params.materialization.serverIdentityId
    ));
    if (!snapshot || snapshot.kind !== 'resolved') return 'missing';
    const machine = snapshot.machines.find((candidate) => candidate.id === params.materialization.machineId);
    if (!machine) return 'missing';
    if (snapshot.observation === 'stale') return 'stale';
    if (machine.availability?.kind === 'locked') return 'unknown';
    const presence = resolveMachinePickerPresence(machine);
    return presence.status === 'online' ? null : presence.status;
}

/**
 * Composes the Artifact-owned uncollapsed materialization projection with
 * Administration's exact machine availability. Immutable release/content and
 * compatibility decisions remain injected from the Artifact owner; this
 * function never manufactures those facts from version strings or UI assets.
 */
export function buildPluginMachineExecutionOriginCandidates(params: Readonly<{
    pluginId: string;
    materializations: readonly PluginMachineMaterializationV1[];
    machineSnapshots: readonly ServerMachineInventorySnapshotV1[];
    classifyRelease: (materialization: PluginMachineMaterializationV1) => PluginMachineReleaseClassificationV1;
}>): readonly PluginMachineExecutionOriginCandidateV1[] {
    return Object.freeze(params.materializations
        .filter((materialization) => materialization.pluginId === params.pluginId)
        .map((materialization) => {
            const release = params.classifyRelease(materialization);
            const directRejection: PluginMachineOriginRejectionReasonV1 | null = materialization.enabled === false
                ? 'disabled'
                : materialization.trustState === 'revoked'
                    ? 'revoked'
                    : materialization.trustState !== 'trusted'
                        ? 'untrusted'
                        : resolveMachineMaterializationRejection({
                            materialization,
                            machineSnapshots: params.machineSnapshots,
                        });
            return Object.freeze({
                materialization,
                releaseContent: release.releaseContent,
                validation: directRejection
                    ? Object.freeze({ kind: 'rejected' as const, reason: directRejection })
                    : release.validation,
            });
        }).sort(compareCandidates));
}

export type PluginMachineExecutionOriginStateV1 =
    | Readonly<{
        kind: 'selected';
        origin: PluginMachineExecutionOriginV1;
        candidate: PluginMachineExecutionOriginCandidateV1;
        selectionSource: 'stored' | 'soleCandidate';
    }>
    | Readonly<{
        kind: 'selectionRequired';
        candidates: readonly PluginMachineExecutionOriginCandidateV1[];
    }>
    | Readonly<{
        kind: 'conflict';
        candidates: readonly PluginMachineExecutionOriginCandidateV1[];
        reasons: readonly ('content_conflict' | 'different_versions' | 'machine_local')[];
    }>
    | Readonly<{
        kind: 'unavailable';
        storedOrigin: PluginMachineExecutionOriginV1 | null;
        candidates: readonly PluginMachineExecutionOriginCandidateV1[];
        reasons: readonly (PluginMachineOriginRejectionReasonV1 | 'no_materialization')[];
    }>;

function compareCandidates(
    left: PluginMachineExecutionOriginCandidateV1,
    right: PluginMachineExecutionOriginCandidateV1,
): number {
    const serverOrder = left.materialization.serverIdentityId.localeCompare(right.materialization.serverIdentityId);
    if (serverOrder !== 0) return serverOrder;
    const machineOrder = left.materialization.machineId.localeCompare(right.materialization.machineId);
    return machineOrder !== 0
        ? machineOrder
        : left.materialization.materializationId.localeCompare(right.materialization.materializationId);
}

export function composePluginMachineExecutionOriginV1(
    materialization: PluginMachineMaterializationV1,
): PluginMachineExecutionOriginV1 {
    return Object.freeze({
        serverIdentityId: materialization.serverIdentityId,
        materializationRef: Object.freeze({
            machineId: materialization.machineId,
            materializationId: materialization.materializationId,
            pluginId: materialization.pluginId,
        }),
    });
}

/** Artifact and machine facts that make an exact origin safe to persist/use. */
export function isPluginMachineExecutionOriginCandidateSelectable(
    candidate: PluginMachineExecutionOriginCandidateV1,
): boolean {
    return candidate.validation.kind === 'admitted'
        && candidate.releaseContent === 'matched'
        && candidate.materialization.portableRelease;
}

function candidateMatchesOrigin(
    candidate: PluginMachineExecutionOriginCandidateV1,
    origin: PluginMachineExecutionOriginV1,
): boolean {
    return isPluginMachineMaterializationOnServerIdentityV1(
        candidate.materialization,
        origin.serverIdentityId,
    ) && isExactPluginMachineMaterializationRefV1(
        candidate.materialization,
        origin.materializationRef,
    );
}

/**
 * Administration's sole zero/one/many plugin-origin decision. Artifact facts
 * and validator results stay uncollapsed inputs. Sorting is presentation only;
 * it never elects an execution origin.
 */
export function resolvePluginMachineExecutionOriginState(params: Readonly<{
    pluginId: string;
    storedOrigin: PluginMachineExecutionOriginV1 | null;
    candidates: readonly PluginMachineExecutionOriginCandidateV1[];
}>): PluginMachineExecutionOriginStateV1 {
    const candidates = Object.freeze([...params.candidates]
        .filter((candidate) => candidate.materialization.pluginId === params.pluginId)
        .sort(compareCandidates));

    if (
        params.storedOrigin !== null
        && params.storedOrigin.materializationRef.pluginId !== params.pluginId
    ) {
        return Object.freeze({
            kind: 'unavailable',
            storedOrigin: params.storedOrigin,
            candidates,
            reasons: Object.freeze(['plugin_mismatch'] as const),
        });
    }

    if (params.storedOrigin !== null) {
        const selected = candidates.find((candidate) => candidateMatchesOrigin(candidate, params.storedOrigin!));
        if (!selected) {
            return Object.freeze({
                kind: 'unavailable',
                storedOrigin: params.storedOrigin,
                candidates,
                reasons: Object.freeze(['missing'] as const),
            });
        }
        if (selected.validation.kind === 'rejected') {
            return Object.freeze({
                kind: 'unavailable',
                storedOrigin: params.storedOrigin,
                candidates,
                reasons: Object.freeze([selected.validation.reason]),
            });
        }
        if (selected.releaseContent !== 'matched') {
            return Object.freeze({
                kind: 'unavailable',
                storedOrigin: params.storedOrigin,
                candidates,
                reasons: Object.freeze([
                    selected.releaseContent === 'conflict' ? 'content_conflict' : 'unknown',
                ] as const),
            });
        }
        if (!selected.materialization.portableRelease) {
            return Object.freeze({
                kind: 'unavailable',
                storedOrigin: params.storedOrigin,
                candidates,
                reasons: Object.freeze(['machine_local'] as const),
            });
        }
        return Object.freeze({
            kind: 'selected',
            origin: params.storedOrigin,
            candidate: selected,
            selectionSource: 'stored',
        });
    }

    const eligible = Object.freeze(candidates.filter((candidate) => candidate.validation.kind === 'admitted'));
    if (eligible.length === 0) {
        const reasons = candidates.length === 0
            ? Object.freeze(['no_materialization'] as const)
            : Object.freeze([...new Set(candidates.map((candidate) => (
                candidate.validation.kind === 'rejected' ? candidate.validation.reason : 'unknown'
            )))]);
        return Object.freeze({ kind: 'unavailable', storedOrigin: null, candidates, reasons });
    }
    if (eligible.some((candidate) => candidate.releaseContent === 'unknown')) {
        return Object.freeze({
            kind: 'unavailable',
            storedOrigin: null,
            candidates,
            reasons: Object.freeze(['unknown'] as const),
        });
    }
    const versions = new Set(eligible.map((candidate) => candidate.materialization.version));
    const conflictReasons: ('content_conflict' | 'different_versions' | 'machine_local')[] = [];
    if (versions.size > 1) conflictReasons.push('different_versions');
    if (eligible.some((candidate) => candidate.releaseContent === 'conflict')) conflictReasons.push('content_conflict');
    if (eligible.some((candidate) => !candidate.materialization.portableRelease)) conflictReasons.push('machine_local');
    if (conflictReasons.length > 0) {
        return Object.freeze({
            kind: 'conflict',
            candidates: eligible,
            reasons: Object.freeze(conflictReasons),
        });
    }

    if (eligible.length === 1) {
        const candidate = eligible[0]!;
        return Object.freeze({
            kind: 'selected',
            origin: composePluginMachineExecutionOriginV1(candidate.materialization),
            candidate,
            selectionSource: 'soleCandidate',
        });
    }

    return Object.freeze({ kind: 'selectionRequired', candidates: eligible });
}
