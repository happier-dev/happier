import { describe, expect, it } from 'vitest';

import type {
    PluginAccountAvailabilityIntentReadResponseV1,
    PluginMachineMaterializationSnapshotV1,
    PluginMachineMaterializationV1,
} from '@happier-dev/protocol/plugins/availability/v1';

import {
    buildPluginMachineExecutionOriginCandidates,
    isPluginMachineExecutionOriginCandidateSelectable,
    type PluginMachineReleaseClassificationV1,
} from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import type { ServerMachineInventorySnapshotV1 } from '@/sync/domains/machines/machineInventorySnapshots';
import type { PluginMachineMaterializationAdmission } from '@/sync/domains/plugins/availability/reader';

import {
    buildPluginMachineMatrix,
    summarizePluginMachines,
    type PluginMachineMatrixCellStateV1,
    type PluginMachineMatrixV1,
} from './pluginMachineMatrix';
import { resolvePluginMachineCoverageLabels } from './pluginMachineCoverage';

const NOW = Date.now();
const OBSERVED_AT = 1_700_000_000_000;

function machine(input: Readonly<{
    id: string;
    displayName?: string;
    online?: boolean;
    revoked?: boolean;
}>): MachineDisplayRenderable {
    return {
        id: input.id,
        updatedAt: NOW,
        active: input.online !== false,
        activeAt: input.online === false ? NOW - 86_400_000 : NOW,
        revokedAt: input.revoked ? NOW - 1_000 : null,
        metadataVersion: 1,
        metadata: { displayName: input.displayName ?? input.id },
    };
}

function resolvedSnapshot(input: Readonly<{
    serverIdentityId: string;
    serverName?: string;
    machines: readonly MachineDisplayRenderable[];
    observation?: 'live' | 'stale';
}>): ServerMachineInventorySnapshotV1 {
    return {
        kind: 'resolved',
        accountId: 'account-a',
        profileId: `profile-${input.serverIdentityId}`,
        serverIdentityId: input.serverIdentityId,
        serverName: input.serverName ?? input.serverIdentityId,
        observation: input.observation ?? 'live',
        ...(input.observation === 'stale' ? {} : { settled: true }),
        machines: input.machines,
    };
}

function materialization(input: Readonly<{
    machineId: string;
    pluginId?: string;
    serverIdentityId?: string;
    version?: string;
    enabled?: boolean;
    trustState?: PluginMachineMaterializationV1['trustState'];
    sourceClass?: PluginMachineMaterializationV1['sourceClass'];
}>): PluginMachineMaterializationV1 {
    const sourceClass = input.sourceClass ?? 'registryPackage';
    return {
        serverIdentityId: input.serverIdentityId ?? 'srv_one',
        machineId: input.machineId,
        materializationId: `mat-${input.machineId}-${input.pluginId ?? 'acme.plugin'}`,
        pluginId: input.pluginId ?? 'acme.plugin',
        version: input.version ?? '1.0.0',
        sourceClass,
        portableRelease: sourceClass !== 'localPath',
        uiArtifacts: [],
        enabled: input.enabled ?? true,
        trustState: input.trustState ?? 'trusted',
        observedAt: OBSERVED_AT,
    };
}

function admission(
    materializations: readonly PluginMachineMaterializationV1[],
    snapshots: readonly PluginMachineMaterializationSnapshotV1[] = materializations.map((row, index) => ({
        serverIdentityId: row.serverIdentityId,
        machineId: row.machineId,
        revision: index + 1,
        materializations: [row],
    })),
    intentReads: readonly Readonly<{
        pluginId: string;
        response: PluginAccountAvailabilityIntentReadResponseV1;
    }>[] = [],
): PluginMachineMaterializationAdmission {
    return { kind: 'available', availabilityCursor: 42, intentReads, materializations, snapshots };
}

const MATCHED: PluginMachineReleaseClassificationV1 = {
    releaseContent: 'matched',
    validation: { kind: 'admitted' },
};
const CONFLICT: PluginMachineReleaseClassificationV1 = {
    releaseContent: 'conflict',
    validation: { kind: 'admitted' },
};
const ACCOUNT_UNKNOWN: PluginMachineReleaseClassificationV1 = {
    releaseContent: 'unknown',
    validation: { kind: 'rejected', reason: 'unknown' },
};

function availableMatrix(matrix: PluginMachineMatrixV1) {
    if (matrix.kind !== 'available') throw new Error(`expected an available matrix, received ${matrix.kind}`);
    return matrix;
}

/** Mirrors the matrix's identity-only machine key format. */
function machineKeyFor(serverIdentityId: string, machineId: string): string {
    return `${serverIdentityId.length}:${serverIdentityId}|${machineId.length}:${machineId}`;
}

function stateByMachineName(
    matrix: PluginMachineMatrixV1,
    pluginId: string,
): Readonly<Record<string, PluginMachineMatrixCellStateV1>> {
    const row = availableMatrix(matrix).rows.find((candidate) => candidate.pluginId === pluginId);
    if (!row) throw new Error(`expected a row for ${pluginId}`);
    return Object.fromEntries(row.cells.map((cell) => [cell.machineName, cell.state]));
}

describe('buildPluginMachineMatrix', () => {
    it('includes desired Account release and artifact truth even before any machine materializes the plugin', () => {
        const response = {
            availabilityCursor: 42,
            packageAssets: [],
            hostingCapability: { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 },
            intent: {
                pluginId: 'acme.desired',
                desiredVersion: '2.0.0',
                enabled: true,
                offlineUiHosting: 'enabled',
                writableCollections: [],
                revision: 'intent-1',
            },
            release: null,
            uiArtifacts: [],
        } satisfies PluginAccountAvailabilityIntentReadResponseV1;
        const matrix = buildPluginMachineMatrix({
            admission: admission([], [], [{ pluginId: 'acme.desired', response }]),
            machineSnapshots: [],
            classifyRelease: () => MATCHED,
        });

        expect(availableMatrix(matrix).rows).toEqual([
            expect.objectContaining({
                pluginId: 'acme.desired',
                accountAvailability: response,
                cells: [],
            }),
        ]);
    });
    it('distinguishes every Account-wide per-machine state the administration matrix promises', () => {
        const snapshots = [resolvedSnapshot({
            serverIdentityId: 'srv_one',
            serverName: 'Server One',
            machines: [
                machine({ id: 'machine-current', displayName: 'Current' }),
                machine({ id: 'machine-disabled', displayName: 'Disabled' }),
                machine({ id: 'machine-untrusted', displayName: 'Untrusted' }),
                machine({ id: 'machine-conflict', displayName: 'Conflict' }),
                machine({ id: 'machine-local', displayName: 'Local' }),
                machine({ id: 'machine-offline', displayName: 'Offline', online: false }),
                machine({ id: 'machine-absent', displayName: 'Absent' }),
            ],
        })];
        const rows = [
            materialization({ machineId: 'machine-current' }),
            materialization({ machineId: 'machine-disabled', enabled: false }),
            materialization({ machineId: 'machine-untrusted', trustState: 'untrusted' }),
            materialization({ machineId: 'machine-conflict', version: '2.0.0' }),
            materialization({ machineId: 'machine-local', sourceClass: 'localPath' }),
            materialization({ machineId: 'machine-offline' }),
            // `machine-absent` reports another plugin, so "not installed" is a
            // fact this machine actually supports.
            materialization({ machineId: 'machine-absent', pluginId: 'other.plugin' }),
        ];

        const matrix = buildPluginMachineMatrix({
            admission: admission(rows),
            machineSnapshots: snapshots,
            classifyRelease: (candidate) => {
                if (!candidate.portableRelease) return ACCOUNT_UNKNOWN;
                return candidate.version === '2.0.0' ? CONFLICT : MATCHED;
            },
            pluginId: 'acme.plugin',
        });

        expect(stateByMachineName(matrix, 'acme.plugin')).toEqual({
            Current: 'installedCurrent',
            Disabled: 'disabled',
            Untrusted: 'untrusted',
            Conflict: 'incompatible',
            Local: 'localOnly',
            Offline: 'staleOffline',
            Absent: 'absent',
        });
        expect(availableMatrix(matrix).rows[0]?.installedCurrentCount).toBe(1);
        expect(availableMatrix(matrix).machineCount).toBe(7);
    });

    it('marks a cell current exactly when the execution-origin owner would admit that machine', () => {
        const machines = [
            machine({ id: 'machine-a', displayName: 'A' }),
            machine({ id: 'machine-b', displayName: 'B', online: false }),
            machine({ id: 'machine-c', displayName: 'C' }),
        ];
        const snapshots = [resolvedSnapshot({ serverIdentityId: 'srv_one', machines })];
        const materializations = [
            materialization({ machineId: 'machine-a' }),
            materialization({ machineId: 'machine-b' }),
            materialization({ machineId: 'machine-c', version: '2.0.0' }),
        ];
        const classifyRelease = (candidate: PluginMachineMaterializationV1) => (
            candidate.version === '2.0.0' ? CONFLICT : MATCHED
        );

        const selectableMachineIds = buildPluginMachineExecutionOriginCandidates({
            pluginId: 'acme.plugin',
            materializations,
            machineSnapshots: snapshots,
            classifyRelease,
        })
            .filter(isPluginMachineExecutionOriginCandidateSelectable)
            .map((candidate) => candidate.materialization.machineId);
        const matrix = buildPluginMachineMatrix({
            admission: admission(materializations),
            machineSnapshots: snapshots,
            classifyRelease,
            pluginId: 'acme.plugin',
        });
        const currentMachineNames = availableMatrix(matrix).rows[0]?.cells
            .filter((cell) => cell.state === 'installedCurrent')
            .map((cell) => cell.machineName);

        expect(selectableMachineIds).toEqual(['machine-a']);
        expect(currentMachineNames).toEqual(['A']);
    });

    it('keeps a retained materialization visible as a stale read-only row when its machine is gone', () => {
        // The materialization survives in Account Availability after its
        // machine disappeared from the inventory. Dropping the cell would
        // hide exactly the stranded installation that explains a stored
        // unavailable origin, so the axis keeps the identity as a stale,
        // target-less observation.
        const snapshots = [resolvedSnapshot({
            serverIdentityId: 'srv_one',
            serverName: 'Server One',
            machines: [machine({ id: 'machine-live', displayName: 'Live' })],
        })];

        const matrix = buildPluginMachineMatrix({
            admission: admission([
                materialization({ machineId: 'machine-live' }),
                materialization({ machineId: 'machine-gone', version: '0.9.0' }),
            ]),
            machineSnapshots: snapshots,
            classifyRelease: () => MATCHED,
            pluginId: 'acme.plugin',
        });

        const row = availableMatrix(matrix).rows[0]!;
        expect(row.installedCurrentCount).toBe(1);
        const orphan = row.cells.find((cell) => cell.machineName === 'machine-gone');
        expect(orphan).not.toBeUndefined();
        expect(orphan).toMatchObject({
            machineKey: machineKeyFor('srv_one', 'machine-gone'),
            serverLabel: 'Server One',
            state: 'machineUnavailable',
            version: '0.9.0',
            observedAt: OBSERVED_AT,
            observation: 'stale',
        });
        // The live axis is unchanged and the orphan carries no executable
        // surface: it renders in the read-only info list like every cell.
        expect(stateByMachineName(matrix, 'acme.plugin')).toEqual({
            Live: 'installedCurrent',
            'machine-gone': 'machineUnavailable',
        });
    });

    it('says a plugin included with Happier is on every machine running Happier unless machines report it', () => {
        const snapshots = [resolvedSnapshot({
            serverIdentityId: 'srv_one',
            machines: [machine({ id: 'machine-a', displayName: 'A' }), machine({ id: 'machine-b', displayName: 'B' })],
        })];
        const matrix = availableMatrix(buildPluginMachineMatrix({
            // Daemons report no materialization for most bundled plugins: they ship inside Happier.
            admission: admission([materialization({ pluginId: 'happier.channels', machineId: 'machine-a', sourceClass: 'bundledFirstParty' })]),
            machineSnapshots: snapshots,
            classifyRelease: () => MATCHED,
            includedWithHappierPluginIds: new Set(['happier.claude', 'happier.channels']),
            pluginId: 'happier.claude',
        }));
        expect(matrix.rows).toEqual([expect.objectContaining({ pluginId: 'happier.claude', includedWithHappier: true, cells: expect.any(Array) })]);

        // Where machines do report it, their per-machine truth stands.
        const reported = availableMatrix(buildPluginMachineMatrix({
            admission: admission([materialization({ pluginId: 'happier.channels', machineId: 'machine-a', sourceClass: 'bundledFirstParty' })]),
            machineSnapshots: snapshots,
            classifyRelease: () => MATCHED,
            includedWithHappierPluginIds: new Set(['happier.channels']),
            pluginId: 'happier.channels',
        }));
        expect(reported.rows[0]?.includedWithHappier).toBe(false);
    });

    it('never presents an unloaded Account projection as an Account-wide grid of absences', () => {
        const matrix = buildPluginMachineMatrix({
            admission: { kind: 'unavailable', code: 'account_availability_not_loaded' },
            machineSnapshots: [resolvedSnapshot({
                serverIdentityId: 'srv_one',
                machines: [machine({ id: 'machine-a', displayName: 'A' })],
            })],
            classifyRelease: () => MATCHED,
            pluginId: 'acme.plugin',
        });

        expect(matrix).toEqual({ kind: 'unavailable', code: 'account_availability_not_loaded' });
    });

    it('reads a machine that has never reported an inventory as unknown rather than not installed', () => {
        const snapshots = [resolvedSnapshot({
            serverIdentityId: 'srv_one',
            machines: [
                machine({ id: 'machine-a', displayName: 'A' }),
                machine({ id: 'machine-silent', displayName: 'Silent' }),
            ],
        })];

        const matrix = buildPluginMachineMatrix({
            admission: admission([materialization({ machineId: 'machine-a' })]),
            machineSnapshots: snapshots,
            classifyRelease: () => MATCHED,
            pluginId: 'acme.plugin',
        });

        expect(stateByMachineName(matrix, 'acme.plugin')).toEqual({
            A: 'installedCurrent',
            Silent: 'unknown',
        });
    });

    it('distinguishes a complete empty machine inventory from a silent machine', () => {
        const snapshots = [resolvedSnapshot({
            serverIdentityId: 'srv_one',
            machines: [
                machine({ id: 'machine-empty', displayName: 'Empty' }),
                machine({ id: 'machine-silent', displayName: 'Silent' }),
            ],
        })];

        const matrix = buildPluginMachineMatrix({
            admission: admission([], [{
                serverIdentityId: 'srv_one',
                machineId: 'machine-empty',
                materializations: [],
            }]),
            machineSnapshots: snapshots,
            classifyRelease: () => MATCHED,
            pluginId: 'acme.plugin',
        });

        expect(stateByMachineName(matrix, 'acme.plugin')).toEqual({
            Empty: 'absent',
            Silent: 'unknown',
        });
    });

    it('discloses servers whose machine inventory is not resolved instead of omitting them silently', () => {
        const matrix = buildPluginMachineMatrix({
            admission: admission([materialization({ machineId: 'machine-a' })]),
            machineSnapshots: [
                resolvedSnapshot({
                    serverIdentityId: 'srv_one',
                    machines: [machine({ id: 'machine-a', displayName: 'A' })],
                }),
                {
                    kind: 'unknown',
                    profileId: 'profile-two',
                    serverIdentityId: 'srv_two',
                    serverName: 'Server Two',
                    machines: [],
                },
            ],
            classifyRelease: () => MATCHED,
        });

        expect(availableMatrix(matrix).unresolvedServerCount).toBe(1);
        expect(availableMatrix(matrix).machineCount).toBe(1);
    });

    it('lists every Account plugin once when no plugin filter is supplied', () => {
        const snapshots = [resolvedSnapshot({
            serverIdentityId: 'srv_one',
            machines: [
                machine({ id: 'machine-a', displayName: 'A' }),
                machine({ id: 'machine-b', displayName: 'B' }),
            ],
        })];

        const matrix = buildPluginMachineMatrix({
            admission: admission([
                materialization({ machineId: 'machine-b', pluginId: 'zeta.plugin' }),
                materialization({ machineId: 'machine-a', pluginId: 'acme.plugin' }),
                materialization({ machineId: 'machine-b', pluginId: 'acme.plugin' }),
            ]),
            machineSnapshots: snapshots,
            classifyRelease: () => MATCHED,
        });

        expect(availableMatrix(matrix).rows.map((row) => row.pluginId)).toEqual([
            'acme.plugin',
            'zeta.plugin',
        ]);
        expect(stateByMachineName(matrix, 'zeta.plugin')).toEqual({ A: 'absent', B: 'installedCurrent' });
    });

    it('names the machine, not the plugin, when the machine itself is revoked or replaced', () => {
        // `revoked` reaches the cell resolver from two different owners: a
        // materialization whose plugin trust was revoked, and a machine whose
        // Account membership was revoked. Only the first is a trust fact, and
        // Administration's own picker already calls the second `unavailable`.
        const snapshots = [resolvedSnapshot({
            serverIdentityId: 'srv_one',
            machines: [
                machine({ id: 'machine-revoked', displayName: 'Revoked', revoked: true }),
                machine({ id: 'machine-untrusted', displayName: 'Untrusted' }),
            ],
        })];

        const matrix = buildPluginMachineMatrix({
            admission: admission([
                materialization({ machineId: 'machine-revoked' }),
                materialization({ machineId: 'machine-untrusted', trustState: 'untrusted' }),
            ]),
            machineSnapshots: snapshots,
            classifyRelease: () => MATCHED,
            pluginId: 'acme.plugin',
        });

        expect(stateByMachineName(matrix, 'acme.plugin')).toEqual({
            Revoked: 'machineUnavailable',
            Untrusted: 'untrusted',
        });
        const revokedOnly = buildPluginMachineMatrix({
            admission: admission([materialization({ machineId: 'machine-revoked' })]),
            machineSnapshots: snapshots,
            classifyRelease: () => MATCHED,
            pluginId: 'acme.plugin',
        });
        expect(resolvePluginMachineCoverageLabels(revokedOnly)).not.toHaveProperty('acme.plugin');
    });

    it('exposes no portable target or execution origin a caller could mutate through', () => {
        const matrix = buildPluginMachineMatrix({
            admission: admission([materialization({ machineId: 'machine-a' })]),
            machineSnapshots: [resolvedSnapshot({
                serverIdentityId: 'srv_one',
                machines: [machine({ id: 'machine-a', displayName: 'A' })],
            })],
            classifyRelease: () => MATCHED,
            pluginId: 'acme.plugin',
        });

        const cell = availableMatrix(matrix).rows[0]?.cells[0];
        expect(cell).toBeDefined();
        expect(Object.keys(cell!).sort()).toEqual([
            'machineKey',
            'machineName',
            'observation',
            'observedAt',
            'retained',
            'serverLabel',
            'state',
            'version',
        ]);
        // A portable target or execution origin is an object; a display cell
        // that carries one could be handed straight to a mutation owner.
        expect(Object.values(cell!).filter((value) => typeof value === 'object' && value !== null)).toEqual([]);
    });
});

describe('summarizePluginMachines', () => {
    function oneRow(materializations: Parameters<typeof admission>[0], machines: ReturnType<typeof machine>[]) {
        const matrix = availableMatrix(buildPluginMachineMatrix({
            admission: admission(materializations),
            machineSnapshots: [resolvedSnapshot({ serverIdentityId: 'srv_one', serverName: 'Server One', machines })],
            classifyRelease: () => MATCHED,
            pluginId: 'acme.plugin',
        }));
        return summarizePluginMachines(matrix.rows[0]!, matrix.machineCount);
    }

    it('counts where the plugin is current and lists only the exceptions, never the healthy, empty or unreported machines', () => {
        const summary = oneRow(
            [materialization({ machineId: 'm-a' }), materialization({ machineId: 'm-b' })],
            [machine({ id: 'm-a', displayName: 'MacBook Pro' }), machine({ id: 'm-b', displayName: 'devbox' }), machine({ id: 'm-c', displayName: 'Studio' })],
        );
        expect(summary.currentCount).toBe(2);
        expect(summary.total).toBe(3);
        expect(summary.currentNames).toEqual(['MacBook Pro', 'devbox']);
        expect(summary.exceptions).toEqual([]);
    });

    it('names a machine that left the Account generically instead of by its raw id', () => {
        const summary = oneRow(
            [materialization({ machineId: 'm-a' }), materialization({ machineId: 'machine-gone', version: '0.9.0' })],
            [machine({ id: 'm-a', displayName: 'MacBook Pro' })],
        );
        expect(summary.exceptions).toHaveLength(1);
        expect(summary.exceptions[0]).toMatchObject({ name: null, state: 'machineUnavailable', version: '0.9.0' });
    });
});
