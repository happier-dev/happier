import type { PluginMachineMaterializationV1 } from '@happier-dev/protocol';

import {
    buildPluginMachineExecutionOriginCandidates,
    isPluginMachineExecutionOriginCandidateSelectable,
    type PluginMachineExecutionOriginCandidateV1,
    type PluginMachineReleaseClassificationV1,
} from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import { buildMachineAdministrationCandidatesFromSnapshots } from '@/sync/domains/machines/administration/targetState';
import type { MachineAdministrationCandidateV1 } from '@/sync/domains/machines/administration/targetSelection';
import type { ServerMachineInventorySnapshotV1 } from '@/sync/domains/machines/machineInventorySnapshots';
import type { PluginMachineMaterializationAdmission } from '@/sync/domains/plugins/availability/reader';

/**
 * One Account-wide answer to "where is this plugin installed, and where is it
 * broken or missing?".
 *
 * `installedCurrent` is deliberately the Administration origin owner's own
 * selectability predicate rather than a second reading of the same facts, so
 * the matrix cannot claim a machine is current while the execution-origin
 * owner rejects it.
 */
export type PluginMachineMatrixCellStateV1 =
    | 'installedCurrent'
    | 'disabled'
    | 'untrusted'
    | 'incompatible'
    | 'localOnly'
    | 'staleOffline'
    | 'machineUnavailable'
    | 'absent'
    | 'unknown';

/**
 * A read-only display row.
 *
 * It intentionally carries no `MachineAdministrationTargetV1` and no
 * `PluginMachineExecutionOriginV1`: a cell therefore cannot be handed to
 * `selectTarget`, `selectOrigin`, or any daemon operation, and the matrix is
 * structurally incapable of becoming an execution or mutation target selector.
 * `machineKey` is a list/lookup key only; it is derived from the machine's
 * identity and is not itself the guarantee. The guarantee is that no cell
 * carries a target, an origin, or a callback, and every row renders `info`.
 */
export type PluginMachineMatrixCellV1 = Readonly<{
    machineKey: string;
    machineName: string;
    serverLabel: string;
    state: PluginMachineMatrixCellStateV1;
    /** Last observed installed version on this machine, never a live claim. */
    version: string | null;
    observedAt: number | null;
    /** Whether the machine row itself is a live or a last-known observation. */
    observation: 'live' | 'stale';
}>;

export type PluginMachineMatrixRowV1 = Readonly<{
    pluginId: string;
    cells: readonly PluginMachineMatrixCellV1[];
    installedCurrentCount: number;
}>;

export type PluginMachineMatrixV1 =
    | Readonly<{
        kind: 'unavailable';
        code: 'account_availability_not_loaded' | 'account_availability_scope_mismatch';
    }>
    | Readonly<{
        kind: 'available';
        availabilityCursor: number;
        machineCount: number;
        /**
         * Servers whose machine inventory is not resolved yet. Their machines
         * are absent from every row, so the matrix discloses that it is
         * incomplete instead of implying an Account-wide negative.
         */
        unresolvedServerCount: number;
        rows: readonly PluginMachineMatrixRowV1[];
    }>;

function machineKey(serverIdentityId: string, machineId: string): string {
    return `${serverIdentityId.length}:${serverIdentityId}|${machineId.length}:${machineId}`;
}

function candidateMachineKey(candidate: MachineAdministrationCandidateV1): string {
    return machineKey(candidate.target.serverIdentityId, candidate.target.machineId);
}

function materializationMachineKey(materialization: Readonly<{
    serverIdentityId: string;
    machineId: string;
}>): string {
    return machineKey(materialization.serverIdentityId, materialization.machineId);
}

/**
 * Reads one already-composed origin candidate. Every input fact is produced by
 * the Administration origin owner or the Account Availability classifier; this
 * function only chooses which of those facts the reader is shown first.
 */
function resolveInstalledCellState(
    candidate: PluginMachineExecutionOriginCandidateV1,
): PluginMachineMatrixCellStateV1 {
    if (isPluginMachineExecutionOriginCandidateSelectable(candidate)) return 'installedCurrent';
    const materialization = candidate.materialization;
    if (!materialization.enabled) return 'disabled';
    if (materialization.trustState !== 'trusted') return 'untrusted';
    // A machine-bound source is never implied to exist Account-wide, and its
    // Account release classification is `unknown` by construction.
    if (!materialization.portableRelease) return 'localOnly';
    if (candidate.releaseContent === 'conflict') return 'incompatible';
    if (candidate.validation.kind === 'rejected') {
        switch (candidate.validation.reason) {
            case 'disabled':
                return 'disabled';
            case 'untrusted':
                return 'untrusted';
            case 'content_conflict':
            case 'incompatible':
            case 'plugin_mismatch':
                return 'incompatible';
            case 'machine_local':
                return 'localOnly';
            case 'offline':
            case 'stale':
                return 'staleOffline';
            // Plugin trust was already decided above, so these reasons can only
            // come from the machine's own presence. Reporting a revoked or
            // replaced machine as an untrusted plugin names the wrong cause;
            // Administration's machine picker calls exactly these unavailable.
            case 'missing':
            case 'replaced':
            case 'revoked':
                return 'machineUnavailable';
            case 'unknown':
                break;
        }
    }
    return 'unknown';
}

/**
 * Composes the Account Availability materialization inventory with
 * Administration's machine presence facts into a read-only Account-wide
 * matrix. It adds no data source, no projection owner, and no refresh loop:
 * both inputs are current facts owned elsewhere.
 */
export function buildPluginMachineMatrix(params: Readonly<{
    admission: PluginMachineMaterializationAdmission;
    machineSnapshots: readonly ServerMachineInventorySnapshotV1[];
    classifyRelease: (materialization: PluginMachineMaterializationV1) => PluginMachineReleaseClassificationV1;
    /** Restricts the matrix to one plugin for the plugin detail route. */
    pluginId?: string;
}>): PluginMachineMatrixV1 {
    if (params.admission.kind !== 'available') {
        return Object.freeze({ kind: 'unavailable', code: params.admission.code });
    }
    const machines = buildMachineAdministrationCandidatesFromSnapshots({
        snapshots: params.machineSnapshots,
    });
    const unresolvedServerCount = params.machineSnapshots
        .filter((snapshot) => snapshot.kind !== 'resolved').length;

    const materializations = params.pluginId === undefined
        ? params.admission.materializations
        : params.admission.materializations.filter((row) => row.pluginId === params.pluginId);
    // Snapshot identity, rather than row presence, is the completeness fact:
    // a complete empty report proves absence while a silent machine stays unknown.
    const reportingMachineKeys = new Set(
        params.admission.snapshots.map(materializationMachineKey),
    );

    const materializationsByPluginId = new Map<string, PluginMachineMaterializationV1[]>();
    for (const materialization of materializations) {
        const rows = materializationsByPluginId.get(materialization.pluginId) ?? [];
        rows.push(materialization);
        materializationsByPluginId.set(materialization.pluginId, rows);
    }
    if (params.pluginId !== undefined && !materializationsByPluginId.has(params.pluginId)) {
        materializationsByPluginId.set(params.pluginId, []);
    }

    const rows = [...materializationsByPluginId.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([pluginId, pluginMaterializations]) => {
            // The install registry reports one materialization per plugin per
            // machine (`materializationIdsByPluginId`), so one candidate per
            // machine key is the complete truth, not a collapsed one.
            const candidatesByMachineKey = new Map<string, PluginMachineExecutionOriginCandidateV1>();
            for (const candidate of buildPluginMachineExecutionOriginCandidates({
                pluginId,
                materializations: pluginMaterializations,
                machineSnapshots: params.machineSnapshots,
                classifyRelease: params.classifyRelease,
            })) {
                candidatesByMachineKey.set(
                    materializationMachineKey(candidate.materialization),
                    candidate,
                );
            }
            let installedCurrentCount = 0;
            const cells = machines.map((machine) => {
                const key = candidateMachineKey(machine);
                const candidate = candidatesByMachineKey.get(key);
                const state = candidate
                    ? resolveInstalledCellState(candidate)
                    : reportingMachineKeys.has(key) ? 'absent' : 'unknown';
                if (state === 'installedCurrent') installedCurrentCount += 1;
                return Object.freeze({
                    machineKey: key,
                    machineName: machine.displayName,
                    serverLabel: machine.serverLabel,
                    state,
                    version: candidate?.materialization.version ?? null,
                    observedAt: candidate?.materialization.observedAt ?? machine.observedAt,
                    observation: machine.observation,
                });
            });
            return Object.freeze({
                pluginId,
                cells: Object.freeze(cells),
                installedCurrentCount,
            });
        });

    return Object.freeze({
        kind: 'available',
        availabilityCursor: params.admission.availabilityCursor,
        machineCount: machines.length,
        unresolvedServerCount,
        rows: Object.freeze(rows),
    });
}
