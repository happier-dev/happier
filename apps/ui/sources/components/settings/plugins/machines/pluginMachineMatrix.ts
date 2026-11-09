import type { PluginMachineMaterializationV1 } from '@happier-dev/protocol/plugins/availability/v1';

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
import type { PluginAccountAvailabilityIntentReadResponseV1 } from '@happier-dev/protocol/plugins/availability';

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
    /**
     * A retained installation on a machine that is no longer in the Account's inventory: its name
     * and server are unknown, so `machineName`/`serverLabel` carry only its raw identity.
     */
    retained: boolean;
}>;

export type PluginMachineMatrixRowV1 = Readonly<{
    pluginId: string;
    /** Exact desired release/artifact truth from the existing Account projection. */
    accountAvailability: PluginAccountAvailabilityIntentReadResponseV1 | null;
    cells: readonly PluginMachineMatrixCellV1[];
    installedCurrentCount: number;
    /**
     * The plugin ships inside Happier (bundled first-party) and no machine reports it: it is on every
     * machine running Happier, so "current on 0 of N" would be false. Machines that do report it keep
     * their per-machine truth.
     */
    includedWithHappier: boolean;
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
    /** Plugins that ship inside Happier (bundled first-party), by id. */
    includedWithHappierPluginIds?: ReadonlySet<string>;
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
    const accountAvailabilityByPluginId = new Map(
        params.admission.intentReads.map((read) => [read.pluginId, read.response] as const),
    );
    for (const pluginId of accountAvailabilityByPluginId.keys()) {
        if (
            (params.pluginId === undefined || params.pluginId === pluginId)
            && !materializationsByPluginId.has(pluginId)
        ) {
            materializationsByPluginId.set(pluginId, []);
        }
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
            // The display axis is the union of current machines and retained
            // materialization identities whose machine no longer exists in the
            // inventory (removed/replaced). Dropping those rows would hide
            // exactly the stranded installation that explains a stored
            // unavailable origin, so they append as stale read-only cells.
            const machineAxisKeys = new Set(machines.map(candidateMachineKey));
            const orphanCandidates: PluginMachineExecutionOriginCandidateV1[] = [];
            for (const [key, candidate] of candidatesByMachineKey) {
                if (!machineAxisKeys.has(key)) orphanCandidates.push(candidate);
            }
            orphanCandidates.sort((left, right) => (
                materializationMachineKey(left.materialization)
                    .localeCompare(materializationMachineKey(right.materialization))
            ));
            let installedCurrentCount = 0;
            const cells = [
                ...machines.map((machine) => {
                    const key = candidateMachineKey(machine);
                    const candidate = candidatesByMachineKey.get(key);
                    const state = candidate
                        ? resolveInstalledCellState(candidate)
                        : reportingMachineKeys.has(key) ? 'absent' as const : 'unknown' as const;
                    if (state === 'installedCurrent') installedCurrentCount += 1;
                    return Object.freeze({
                        machineKey: key,
                        machineName: machine.displayName,
                        serverLabel: machine.serverLabel,
                        state,
                        version: candidate?.materialization.version ?? null,
                        observedAt: candidate?.materialization.observedAt ?? machine.observedAt,
                        observation: machine.observation,
                        retained: false,
                    });
                }),
                ...orphanCandidates.map((candidate) => {
                    const materialization = candidate.materialization;
                    // No live machine row remains, so the retained identity and
                    // last observation are all the display facts available. The
                    // server label still resolves from the server's inventory
                    // snapshot when the server itself is known.
                    const serverSnapshot = params.machineSnapshots.find((snapshot) => (
                        snapshot.kind === 'resolved'
                        && snapshot.serverIdentityId === materialization.serverIdentityId
                    ));
                    return Object.freeze({
                        machineKey: materializationMachineKey(materialization),
                        machineName: materialization.machineId,
                        serverLabel: serverSnapshot?.kind === 'resolved'
                            ? serverSnapshot.serverName
                            : materialization.serverIdentityId,
                        // No live inventory target exists, so this row cannot
                        // inherit a selectable/current classification even if
                        // its retained release bytes still match.
                        state: 'machineUnavailable' as const,
                        version: materialization.version,
                        observedAt: materialization.observedAt,
                        observation: 'stale' as const,
                        retained: true,
                    });
                }),
            ];
            return Object.freeze({
                pluginId,
                accountAvailability: accountAvailabilityByPluginId.get(pluginId) ?? null,
                cells: Object.freeze(cells),
                installedCurrentCount,
                includedWithHappier: pluginMaterializations.length === 0
                    && params.includedWithHappierPluginIds?.has(pluginId) === true,
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

/** A machine where the plugin needs a look: offline with a last-known version, disabled, not trusted… */
export type PluginMachineSummaryExceptionV1 = Readonly<{
    machineKey: string;
    /** `null` for a machine that left the Account: it is named generically, never by its raw id. */
    name: string | null;
    /** `null` when the machine's server is not known either. */
    serverLabel: string | null;
    state: PluginMachineMatrixCellStateV1;
    version: string | null;
    observedAt: number | null;
}>;

export type PluginMachineSummaryV1 = Readonly<{
    /** Machines running the Account's release of the plugin. */
    currentCount: number;
    /** Machines in the Account's inventory. */
    total: number;
    currentNames: readonly string[];
    /** Only the machines that need a look; a healthy, empty or unreported machine is not one. */
    exceptions: readonly PluginMachineSummaryExceptionV1[];
}>;

/** One plugin's row of the matrix as "current on N of M machines" plus its exceptions. */
export function summarizePluginMachines(row: PluginMachineMatrixRowV1, machineCount: number): PluginMachineSummaryV1 {
    const current = row.cells.filter((cell) => cell.state === 'installedCurrent');
    const exceptions = row.cells
        // Nothing to look at on a machine that is current, doesn't have the plugin, or hasn't
        // reported its plugins at all; the "N of M" line already counts those as not current.
        .filter((cell) => cell.state !== 'installedCurrent' && cell.state !== 'absent' && cell.state !== 'unknown')
        .map((cell) => Object.freeze({
            machineKey: cell.machineKey,
            name: cell.retained ? null : cell.machineName,
            // A retained cell's server label may be the raw server identity; say nothing rather than that.
            serverLabel: cell.retained ? null : cell.serverLabel,
            state: cell.state,
            version: cell.version,
            observedAt: cell.observedAt,
        }));
    return Object.freeze({
        currentCount: current.length,
        total: machineCount,
        currentNames: Object.freeze(current.map((cell) => cell.machineName)),
        exceptions: Object.freeze(exceptions),
    });
}
