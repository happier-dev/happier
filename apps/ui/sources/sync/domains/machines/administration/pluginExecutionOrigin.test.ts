import { describe, expect, it } from 'vitest';

import {
    buildPluginMachineExecutionOriginCandidates,
    resolvePluginMachineExecutionOriginState,
    type PluginMachineExecutionOriginCandidateV1,
} from './pluginExecutionOrigin';

function candidate(input: Readonly<{
    serverIdentityId: string;
    machineId: string;
    materializationId: string;
    pluginId?: string;
    version?: string;
    releaseContent?: PluginMachineExecutionOriginCandidateV1['releaseContent'];
    validation?: PluginMachineExecutionOriginCandidateV1['validation'];
    sourceClass?: PluginMachineExecutionOriginCandidateV1['materialization']['sourceClass'];
}>): PluginMachineExecutionOriginCandidateV1 {
    return {
        materialization: {
            serverIdentityId: input.serverIdentityId,
            machineId: input.machineId,
            materializationId: input.materializationId,
            pluginId: input.pluginId ?? 'acme.plugin',
            version: input.version ?? '1.0.0',
            sourceClass: input.sourceClass ?? 'registryPackage',
            portableRelease: input.sourceClass !== 'localPath',
            uiArtifacts: [],
            enabled: true,
            trustState: 'trusted',
            observedAt: 100,
        },
        releaseContent: input.releaseContent ?? 'matched',
        validation: input.validation ?? { kind: 'admitted' },
    };
}

describe('resolvePluginMachineExecutionOriginState', () => {
    it('selects an exact admitted source and preserves an unavailable saved source', () => {
        const origin = { serverIdentityId: 'srv_one', sourceRef: { machineId: 'machine-a', pluginId: 'acme.plugin',
            sourceCustody: { kind: 'development', registeredRootId: 'registered-source-a' } } } as const;
        const sourceCandidate = { source: { origin, version: '1.0.0', occurrenceId: 'occurrence-a',
            serverId: 'local-one', generation: 1 }, releaseContent: 'matched', validation: { kind: 'admitted' } } as const;
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: null,
            candidates: [sourceCandidate] })).toMatchObject({ kind: 'selected', origin, selectionSource: 'soleCandidate' });
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: origin,
            candidates: [{ ...sourceCandidate, validation: { kind: 'rejected', reason: 'offline' } }] }))
            .toMatchObject({ kind: 'unavailable', storedOrigin: origin, reasons: ['offline'] });
        const replacement = { ...sourceCandidate, source: { ...sourceCandidate.source, origin: { ...origin,
            sourceRef: { ...origin.sourceRef, sourceCustody: { kind: 'development', registeredRootId: 'replacement-source' } } } } } as const;
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: origin,
            candidates: [replacement] })).toMatchObject({ kind: 'unavailable', reasons: ['missing'] });
    });
    it('uses an admitted plugin default after explicit preference and before sole selection', () => {
        const a = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-a', materializationId: 'mat-a' });
        const b = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-b', materializationId: 'mat-b' });
        const origin = (entry: typeof a) => ({ serverIdentityId: entry.materialization.serverIdentityId,
            materializationRef: { machineId: entry.materialization.machineId, materializationId: entry.materialization.materializationId, pluginId: 'acme.plugin' } });
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: null,
            candidates: [a, b], declaredDefaultOrigins: [origin(b)] })).toMatchObject({ kind: 'selected', origin: origin(b), selectionSource: 'pluginDefault' });
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: null,
            candidates: [{ ...a, releaseContent: 'unknown' }, b], declaredDefaultOrigins: [origin(b)] }))
            .toMatchObject({ kind: 'selected', origin: origin(b), selectionSource: 'pluginDefault' });
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: origin(a),
            candidates: [a, b], declaredDefaultOrigins: [origin(b)] })).toMatchObject({ kind: 'selected', origin: origin(a), selectionSource: 'stored' });
        const offline = { ...a, validation: { kind: 'rejected', reason: 'offline' } } as const;
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: origin(a),
            candidates: [offline, b], declaredDefaultOrigins: [origin(b)] })).toMatchObject({ kind: 'unavailable', reasons: ['offline'] });
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: null,
            candidates: [a, b], declaredDefaultOrigins: [origin(a), origin(b)] }).kind).toBe('selectionRequired');
    });
    it('composes uncollapsed Availability rows with exact machine state and Artifact-owned release validation', () => {
        const materialization = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-a',
            materializationId: 'mat-a',
        }).materialization;
        const candidates = buildPluginMachineExecutionOriginCandidates({
            pluginId: 'acme.plugin',
            materializations: [materialization],
            machineSnapshots: [{
                kind: 'resolved',
                profileId: 'local-one',
                serverIdentityId: 'srv_one',
                serverName: 'Server One',
                observation: 'live',
                machines: [{
                    id: 'machine-a',
                    updatedAt: 100,
                    active: true,
                    activeAt: Date.now(),
                    revokedAt: null,
                    metadataVersion: 1,
                    metadata: null,
                }],
            }],
            classifyRelease: () => ({
                releaseContent: 'matched',
                validation: { kind: 'admitted' },
            }),
        });

        expect(candidates).toEqual([{
            materialization,
            releaseContent: 'matched',
            validation: { kind: 'admitted' },
        }]);
    });

    it('keeps the candidate set scoped to the requested plugin before presentation', () => {
        const own = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-a',
            materializationId: 'mat-own',
        }).materialization;
        const foreign = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-a',
            materializationId: 'mat-foreign',
            pluginId: 'other.plugin',
        }).materialization;
        const input = {
            pluginId: 'acme.plugin',
            materializations: [foreign, own],
            machineSnapshots: [{
                kind: 'resolved' as const,
                profileId: 'local-one',
                serverIdentityId: 'srv_one',
                serverName: 'Server One',
                observation: 'live' as const,
                machines: [{
                    id: 'machine-a',
                    updatedAt: 100,
                    active: true,
                    activeAt: Date.now(),
                    revokedAt: null,
                    metadataVersion: 1,
                    metadata: null,
                }],
            }],
            classifyRelease: () => ({
                releaseContent: 'matched' as const,
                validation: { kind: 'admitted' as const },
            }),
        };

        expect(buildPluginMachineExecutionOriginCandidates(input).map((entry) => entry.materialization.pluginId))
            .toEqual(['acme.plugin']);
    });

    it('fails stale, replaced, revoked, disabled, and untrusted Availability rows closed before selection', () => {
        const base = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-a',
            materializationId: 'mat-a',
        }).materialization;
        const classifyRelease = () => ({
            releaseContent: 'matched' as const,
            validation: { kind: 'admitted' as const },
        });
        const machineSnapshot = (machine: Readonly<{
            replacedByMachineId?: string;
            revokedAt?: number;
        }>, observation: 'live' | 'stale' = 'live') => [{
            kind: 'resolved' as const,
            profileId: 'local-one',
            serverIdentityId: 'srv_one',
            serverName: 'Server One',
            observation,
            machines: [{
                id: 'machine-a',
                updatedAt: 100,
                active: true,
                activeAt: Date.now(),
                revokedAt: machine.revokedAt ?? null,
                replacedByMachineId: machine.replacedByMachineId ?? null,
                metadataVersion: 1,
                metadata: null,
            }],
        }];

        expect(buildPluginMachineExecutionOriginCandidates({
            pluginId: 'acme.plugin',
            materializations: [base],
            machineSnapshots: machineSnapshot({}, 'stale'),
            classifyRelease,
        })[0]?.validation).toEqual({ kind: 'rejected', reason: 'stale' });
        expect(buildPluginMachineExecutionOriginCandidates({
            pluginId: 'acme.plugin',
            materializations: [base],
            machineSnapshots: machineSnapshot({ replacedByMachineId: 'machine-b' }),
            classifyRelease,
        })[0]?.validation).toEqual({ kind: 'rejected', reason: 'replaced' });
        expect(buildPluginMachineExecutionOriginCandidates({
            pluginId: 'acme.plugin',
            materializations: [base],
            machineSnapshots: machineSnapshot({ revokedAt: 100 }),
            classifyRelease,
        })[0]?.validation).toEqual({ kind: 'rejected', reason: 'revoked' });
        expect(buildPluginMachineExecutionOriginCandidates({
            pluginId: 'acme.plugin',
            materializations: [{ ...base, enabled: false }],
            machineSnapshots: machineSnapshot({}),
            classifyRelease,
        })[0]?.validation).toEqual({ kind: 'rejected', reason: 'disabled' });
        expect(buildPluginMachineExecutionOriginCandidates({
            pluginId: 'acme.plugin',
            materializations: [{ ...base, trustState: 'untrusted' }],
            machineSnapshots: machineSnapshot({}),
            classifyRelease,
        })[0]?.validation).toEqual({ kind: 'rejected', reason: 'untrusted' });
    });

    it('does not call a materialization\'s machine missing while its Home\'s machine list is unread', () => {
        const base = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-a', materializationId: 'mat-a' }).materialization;
        const classifyRelease = () => ({ releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } });
        const unread = [{ kind: 'unknown' as const, profileId: 'local-one', serverIdentityId: 'srv_one', serverName: 'Server One', machines: [] }];
        expect(buildPluginMachineExecutionOriginCandidates({
            pluginId: 'acme.plugin',
            materializations: [base],
            machineSnapshots: unread,
            classifyRelease,
        })[0]?.validation).toEqual({ kind: 'rejected', reason: 'unknown' });
        // A read list that lacks the machine: now it has really left.
        const read = [{ kind: 'resolved' as const, profileId: 'local-one', serverIdentityId: 'srv_one', serverName: 'Server One', observation: 'live' as const, settled: true as const, machines: [] }];
        expect(buildPluginMachineExecutionOriginCandidates({
            pluginId: 'acme.plugin',
            materializations: [base],
            machineSnapshots: read,
            classifyRelease,
        })[0]?.validation).toEqual({ kind: 'rejected', reason: 'missing' });
    });

    it('does not infer executable installation from a bundled plugin identity', () => {
        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'happier.claude',
            storedOrigin: null,
            candidates: [],
        })).toEqual({ kind: 'unavailable', storedOrigin: null, candidates: [], reasons: ['no_materialization'] });
    });

    it('reports unavailable for zero candidates and structurally selects the sole admitted origin', () => {
        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin: null,
            candidates: [],
        })).toEqual({ kind: 'unavailable', storedOrigin: null, candidates: [], reasons: ['no_materialization'] });

        const only = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-a',
            materializationId: 'mat-a',
        });
        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin: null,
            candidates: [only],
        })).toEqual({
            kind: 'selected',
            origin: {
                serverIdentityId: 'srv_one',
                materializationRef: {
                    machineId: 'machine-a',
                    materializationId: 'mat-a',
                    pluginId: 'acme.plugin',
                },
            },
            candidate: only,
            selectionSource: 'soleCandidate',
        });
    });

    it('requires explicit choice between matching replicas and is stable under input permutation', () => {
        const machineA = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-a', materializationId: 'mat-a' });
        const machineB = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-b', materializationId: 'mat-b' });

        const first = resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin: null,
            candidates: [machineB, machineA],
        });
        const reordered = resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin: null,
            candidates: [machineA, machineB],
        });

        expect(first).toEqual({ kind: 'selectionRequired', candidates: [machineA, machineB] });
        expect(reordered).toEqual(first);
    });

    it('fails closed for divergent versions, conflicting content, and machine-local rows', () => {
        const base = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-a', materializationId: 'mat-a' });
        const divergent = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-b',
            materializationId: 'mat-b',
            version: '2.0.0',
        });
        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin: null,
            candidates: [base, divergent],
        }).kind).toBe('conflict');

        const contentConflict = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-b',
            materializationId: 'mat-b',
            releaseContent: 'conflict',
        });
        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin: null,
            candidates: [base, contentConflict],
        }).kind).toBe('conflict');

        const local = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-b',
            materializationId: 'mat-local',
            sourceClass: 'localPath',
        });
        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin: null,
            candidates: [base, local],
        }).kind).toBe('conflict');
    });

    it('retains an unavailable stored origin and never roams to another admitted replica', () => {
        const old = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-a',
            materializationId: 'mat-a',
            validation: { kind: 'rejected', reason: 'offline' },
        });
        const replacement = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-b',
            materializationId: 'mat-b',
        });

        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin: {
                serverIdentityId: 'srv_one',
                materializationRef: {
                    machineId: 'machine-a',
                    materializationId: 'mat-a',
                    pluginId: 'acme.plugin',
                },
            },
            candidates: [replacement, old],
        })).toEqual({
            kind: 'unavailable',
            storedOrigin: {
                serverIdentityId: 'srv_one',
                materializationRef: {
                    machineId: 'machine-a',
                    materializationId: 'mat-a',
                    pluginId: 'acme.plugin',
                },
            },
            candidates: [old, replacement],
            reasons: ['offline'],
        });
    });

    it('reports a vanished install epoch as missing instead of relocating to a healthy replica', () => {
        // Reinstalling mints a new installation epoch, so the stored epoch can
        // disappear while another admitted replica is present. Relocating there
        // silently would move execution to a machine the user never chose.
        const replacement = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-b',
            materializationId: 'mat-b',
        });
        const storedOrigin = {
            serverIdentityId: 'srv_one',
            materializationRef: {
                machineId: 'machine-a',
                materializationId: 'mat-a-retired',
                pluginId: 'acme.plugin',
            },
        } as const;

        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin,
            candidates: [replacement],
        })).toEqual({
            kind: 'unavailable',
            storedOrigin,
            candidates: [replacement],
            reasons: ['missing'],
        });

        // Positive twin: once the stored epoch is reported again it is selected,
        // so the result above is the no-relocation rule and not a dead branch.
        const restored = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-a',
            materializationId: 'mat-a-retired',
        });
        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin,
            candidates: [replacement, restored],
        })).toMatchObject({
            kind: 'selected',
            origin: storedOrigin,
            selectionSource: 'stored',
        });
    });

    it('rejects a stored origin for another plugin instead of borrowing it', () => {
        const current = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-a', materializationId: 'mat-a' });

        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin: {
                serverIdentityId: 'srv_one',
                materializationRef: {
                    machineId: 'machine-a',
                    materializationId: 'mat-a',
                    pluginId: 'other.plugin',
                },
            },
            candidates: [current],
        })).toEqual({
            kind: 'unavailable',
            storedOrigin: expect.objectContaining({
                materializationRef: expect.objectContaining({ pluginId: 'other.plugin' }),
            }),
            candidates: [current],
            reasons: ['plugin_mismatch'],
        });
    });

    it('withholds a stored origin when release facts conflict even if a validator is accidentally permissive', () => {
        const conflicting = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-a',
            materializationId: 'mat-a',
            releaseContent: 'conflict',
            validation: { kind: 'admitted' },
        });

        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin: {
                serverIdentityId: 'srv_one',
                materializationRef: {
                    machineId: 'machine-a',
                    materializationId: 'mat-a',
                    pluginId: 'acme.plugin',
                },
            },
            candidates: [conflicting],
        })).toEqual({
            kind: 'unavailable',
            storedOrigin: expect.any(Object),
            candidates: [conflicting],
            reasons: ['content_conflict'],
        });
    });

    it('does not misreport an unknown stored release fact as a proven content conflict', () => {
        const unknown = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-a',
            materializationId: 'mat-a',
            releaseContent: 'unknown',
            validation: { kind: 'admitted' },
        });

        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin: {
                serverIdentityId: 'srv_one',
                materializationRef: {
                    machineId: 'machine-a',
                    materializationId: 'mat-a',
                    pluginId: 'acme.plugin',
                },
            },
            candidates: [unknown],
        })).toEqual({
            kind: 'unavailable',
            storedOrigin: expect.any(Object),
            candidates: [unknown],
            reasons: ['unknown'],
        });

        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin: null,
            candidates: [unknown],
        })).toEqual({
            kind: 'unavailable',
            storedOrigin: null,
            candidates: [unknown],
            reasons: ['unknown'],
        });
    });
});
