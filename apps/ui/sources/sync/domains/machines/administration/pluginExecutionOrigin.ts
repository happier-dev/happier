import { arePluginMachineExecutionOriginsEqual, getPluginMachineExecutionOriginRef, type PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { type PluginMachineMaterializationV1 } from '@happier-dev/protocol/plugins/availability/v1';

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

/** An admitted real projection source, never a synthesized installation row. */
export type PluginMachineSourceExecutionOriginCandidateV1 = PluginMachineReleaseClassificationV1 & Readonly<{
    source: Readonly<{
        origin: Extract<PluginMachineExecutionOriginV1, { sourceRef: unknown }>;
        version: string;
        occurrenceId: string;
        serverId: string;
        generation: number;
    }>;
}>;
export type PluginExecutionOriginCandidateV1 = PluginMachineExecutionOriginCandidateV1 | PluginMachineSourceExecutionOriginCandidateV1;

export function getPluginExecutionOriginCandidateOrigin(candidate: PluginExecutionOriginCandidateV1): PluginMachineExecutionOriginV1 {
    return 'source' in candidate ? candidate.source.origin : composePluginMachineExecutionOriginV1(candidate.materialization);
}

export function getPluginExecutionOriginCandidateVersion(candidate: PluginExecutionOriginCandidateV1): string {
    return 'source' in candidate ? candidate.source.version : candidate.materialization.version;
}

function resolveMachineMaterializationRejection(params: Readonly<{
    materialization: Pick<PluginMachineMaterializationV1, 'serverIdentityId' | 'machineId'>;
    machineSnapshots: readonly ServerMachineInventorySnapshotV1[];
}>): PluginMachineOriginRejectionReasonV1 | null {
    const snapshot = params.machineSnapshots.find((candidate) => (
        candidate.kind === 'resolved'
        && candidate.serverIdentityId === params.materialization.serverIdentityId
    ));
    // An unread Home's machine list cannot say a machine left it.
    if (!snapshot || snapshot.kind !== 'resolved') return 'unknown';
    const machine = snapshot.machines.find((candidate) => candidate.id === params.materialization.machineId);
    if (!machine) return snapshot.settled === true ? 'missing' : 'unknown';
    if (snapshot.observation === 'stale') return 'stale';
    if (machine.availability?.kind === 'locked') return 'unknown';
    const presence = resolveMachinePickerPresence(machine);
    return presence.status === 'online' ? null : presence.status;
}

export function buildPluginMachineSourceExecutionOriginCandidates(params: Readonly<{
    pluginId: string;
    sources: readonly PluginMachineSourceExecutionOriginCandidateV1[];
    machineSnapshots: readonly ServerMachineInventorySnapshotV1[];
}>): readonly PluginMachineSourceExecutionOriginCandidateV1[] {
    return Object.freeze(params.sources.filter((candidate) => candidate.source.origin.sourceRef.pluginId === params.pluginId).map((candidate) => {
        const origin = candidate.source.origin;
        const reason = resolveMachineMaterializationRejection({
            materialization: { serverIdentityId: origin.serverIdentityId, machineId: origin.sourceRef.machineId },
            machineSnapshots: params.machineSnapshots,
        });
        return reason ? Object.freeze({ ...candidate, validation: { kind: 'rejected' as const, reason } }) : candidate;
    }));
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
        candidate: PluginExecutionOriginCandidateV1;
        selectionSource: 'stored' | 'pluginDefault' | 'soleCandidate';
    }>
    | Readonly<{
        kind: 'selectionRequired';
        candidates: readonly PluginExecutionOriginCandidateV1[];
    }>
    | Readonly<{
        kind: 'conflict';
        candidates: readonly PluginExecutionOriginCandidateV1[];
        reasons: readonly ('content_conflict' | 'different_versions' | 'machine_local')[];
    }>
    | Readonly<{
        kind: 'unavailable';
        storedOrigin: PluginMachineExecutionOriginV1 | null;
        candidates: readonly PluginExecutionOriginCandidateV1[];
        reasons: readonly (PluginMachineOriginRejectionReasonV1 | 'no_materialization')[];
    }>;

function compareCandidates(
    left: PluginExecutionOriginCandidateV1,
    right: PluginExecutionOriginCandidateV1,
): number {
    const leftOrigin = getPluginExecutionOriginCandidateOrigin(left);
    const rightOrigin = getPluginExecutionOriginCandidateOrigin(right);
    const serverOrder = leftOrigin.serverIdentityId.localeCompare(rightOrigin.serverIdentityId);
    if (serverOrder !== 0) return serverOrder;
    const machineOrder = getPluginMachineExecutionOriginRef(leftOrigin).machineId.localeCompare(getPluginMachineExecutionOriginRef(rightOrigin).machineId);
    return machineOrder !== 0
        ? machineOrder
        : JSON.stringify(leftOrigin).localeCompare(JSON.stringify(rightOrigin));
}

export function composePluginMachineExecutionOriginV1(
    materialization: PluginMachineMaterializationV1,
): Extract<PluginMachineExecutionOriginV1, { materializationRef: unknown }> {
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
    candidate: PluginExecutionOriginCandidateV1,
): boolean {
    return candidate.validation.kind === 'admitted'
        && candidate.releaseContent === 'matched'
        && ('source' in candidate || candidate.materialization.portableRelease);
}

function candidateMatchesOrigin(
    candidate: PluginExecutionOriginCandidateV1,
    origin: PluginMachineExecutionOriginV1,
): boolean {
    return arePluginMachineExecutionOriginsEqual(getPluginExecutionOriginCandidateOrigin(candidate), origin);
}

/**
 * Administration's sole zero/one/many plugin-origin decision. Artifact facts
 * and validator results stay uncollapsed inputs. Sorting is presentation only;
 * it never elects an execution origin.
 */
export function resolvePluginMachineExecutionOriginState(params: Readonly<{
    pluginId: string;
    storedOrigin: PluginMachineExecutionOriginV1 | null;
    candidates: readonly PluginExecutionOriginCandidateV1[];
    /** Exact supplying origins carrying an admitted installation-default hint. */
    declaredDefaultOrigins?: readonly PluginMachineExecutionOriginV1[];
}>): PluginMachineExecutionOriginStateV1 {
    const candidates = Object.freeze([...params.candidates]
        .filter((candidate) => getPluginMachineExecutionOriginRef(getPluginExecutionOriginCandidateOrigin(candidate)).pluginId === params.pluginId)
        .sort(compareCandidates));

    if (
        params.storedOrigin !== null
        && getPluginMachineExecutionOriginRef(params.storedOrigin).pluginId !== params.pluginId
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
        if ('materialization' in selected && !selected.materialization.portableRelease) {
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
    // A default is merely a preference. It can select only an admitted exact
    // origin, and several supplying defaults leave the user's choice open.
    const defaults = eligible.filter((candidate) => isPluginMachineExecutionOriginCandidateSelectable(candidate)
        && params.declaredDefaultOrigins?.some((origin) => candidateMatchesOrigin(candidate, origin)));
    if (defaults.length === 1) {
        const candidate = defaults[0]!;
        return Object.freeze({ kind: 'selected', origin: getPluginExecutionOriginCandidateOrigin(candidate), candidate, selectionSource: 'pluginDefault' });
    }
    if (eligible.some((candidate) => candidate.releaseContent === 'unknown')) {
        return Object.freeze({
            kind: 'unavailable',
            storedOrigin: null,
            candidates,
            reasons: Object.freeze(['unknown'] as const),
        });
    }
    const versions = new Set(eligible.map(getPluginExecutionOriginCandidateVersion));
    const conflictReasons: ('content_conflict' | 'different_versions' | 'machine_local')[] = [];
    if (versions.size > 1) conflictReasons.push('different_versions');
    if (eligible.some((candidate) => candidate.releaseContent === 'conflict')) conflictReasons.push('content_conflict');
    if (eligible.some((candidate) => 'materialization' in candidate && !candidate.materialization.portableRelease)) conflictReasons.push('machine_local');
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
            origin: getPluginExecutionOriginCandidateOrigin(candidate),
            candidate,
            selectionSource: 'soleCandidate',
        });
    }

    return Object.freeze({ kind: 'selectionRequired', candidates: eligible });
}
