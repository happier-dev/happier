import { afterEach, describe, expect, it } from 'vitest';

import { createMachineFixture } from '@/dev/testkit';
import { publishMachineActivityForTest } from '@/dev/testkit/harness/machinePresence';
import { ProjectWorkerStatusResultV1Schema, type ProjectWorkerStatusResultV1 } from '@happier-dev/protocol/actions/specs/projectWorkers';
import { type MachinePoolViewV1} from '@happier-dev/protocol/machines/pools/v1';
import type { Machine } from '@/sync/domains/state/storageTypes';

import {
    buildMachineDestinationModel as buildScopedMachineDestinationModel,
    resolveMachinePoolRowUnavailableReason,
    resolveMachineDestinationPurposeEligibility as resolveScopedMachineDestinationPurposeEligibility,
    describeMachineDestinationWorkerFacts,
} from './buildMachineDestinationModel';
import { t } from '@/text';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';
import { clearMachineRequestReachabilityForTest, recordMachineRequestFailed, recordMachineRequestSucceeded } from '@/sync/domains/machines/reachability/machineReachability';

afterEach(clearMachineRequestReachabilityForTest);
const fixtureScope = { serverId: 'server-a', accountId: 'account-a' };
const resolveMachineDestinationPurposeEligibility: typeof resolveScopedMachineDestinationPurposeEligibility =
    (purpose, facts, machine, scope = fixtureScope) => resolveScopedMachineDestinationPurposeEligibility(purpose, facts, machine, scope);
function buildMachineDestinationModel(input: Parameters<typeof buildScopedMachineDestinationModel>[0]) {
    const scopesByServerId = new Map(input.groups.map(group => [group.serverId, { serverId: group.serverId, accountId: 'account-a' }]));
    return buildScopedMachineDestinationModel({ ...input, scopesByServerId: input.scopesByServerId ?? scopesByServerId });
}

function machine(id: string, overrides: Partial<Machine> = {}): Machine & { serverId: string; serverName: string } {
    const result = {
        ...createMachineFixture({ id }),
        active: true,
        activeAt: Date.now(),
        ...overrides,
        serverId: 'server-a',
        serverName: 'Server A',
    } as Machine & { serverId: string; serverName: string };
    publishMachineActivityForTest([result]);
    return result;
}

function group(overrides: Partial<Parameters<typeof buildMachineDestinationModel>[0]['groups'][number]> = {}) {
    return {
        serverId: 'server-a',
        serverName: 'Server A',
        loading: false,
        signedOut: false,
        machines: [machine('machine-1')],
        ...overrides,
    } as Parameters<typeof buildMachineDestinationModel>[0]['groups'][number];
}

function pool(id: string): MachinePoolViewV1 {
    return {
        pool: {
            id,
            name: 'Development',
            description: null,
            revision: 1,
            createdAt: 1,
            updatedAt: 1,
            members: [],
        },
        availability: { state: 'known', connectedCount: 1, enabledCount: 1 },
    };
}

function eligibleWorker(machineId: string, load: ProjectWorkerStatusResultV1['load'] = { kind: 'unknown' }): Extract<ProjectWorkerStatusResultV1, { eligible: true }> {
    return { eligible: true, candidate: { serverId: 'server-a', machineId }, load,
        explanation: load.kind === 'known' ? 'eligible' : 'load_unknown' };
}

describe('resolveMachinePoolRowUnavailableReason', () => {
    it('keeps a current Home selectable even when its cached connection summary reports zero', () => {
        const zeroConnected: MachinePoolViewV1 = {
            ...pool('pool-a'),
            availability: { state: 'known', connectedCount: 0, enabledCount: 2 },
        };
        expect(resolveMachinePoolRowUnavailableReason({
            group: { loading: false, signedOut: false },
            poolGroup: { serverId: 'server-a', pools: [zeroConnected], status: 'idle', projectionReady: true },
        })).toBeNull();
    });

    it('reports the Home fact that blocks activation instead of a generic unavailable state', () => {
        const poolGroup = { serverId: 'server-a', pools: [pool('pool-a')], status: 'idle' as const, projectionReady: true };
        const failedHome = { loading: false, signedOut: false, error: true };
        expect(resolveMachinePoolRowUnavailableReason({
            group: failedHome, poolGroup,
        })).toBe('homeFailed');
        expect(resolveMachinePoolRowUnavailableReason({
            group: { loading: false, signedOut: true }, poolGroup,
        })).toBe('homeSignedOut');
        expect(resolveMachinePoolRowUnavailableReason({
            group: { loading: true, signedOut: false }, poolGroup,
        })).toBe('homeLoading');
        expect(resolveMachinePoolRowUnavailableReason({
            group: { loading: false, signedOut: false },
            poolGroup: { ...poolGroup, status: 'error', projectionReady: false },
        })).toBe('poolsFailed');
        expect(resolveMachinePoolRowUnavailableReason({
            group: { loading: false, signedOut: false },
            poolGroup: { ...poolGroup, status: 'signedOut', projectionReady: false },
        })).toBe('poolsSignedOut');
        expect(resolveMachinePoolRowUnavailableReason({
            group: { loading: false, signedOut: false },
            poolGroup: { ...poolGroup, projectionReady: false },
        })).toBe('poolsLoading');
    });
});

describe('buildMachineDestinationModel', () => {
    it.each(['all', 'recent', 'favorites', 'shared'] as const)('denies the sole %s destination after an exact-Home failure and restores it only after success', placement => {
        const candidate = machine('reachability-machine', placement === 'shared' ? { isShared: true, access: {
            custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use', resourceMode: 'plain', accessState: 'ready',
        } } : {});
        const params = { groups: [group({ machines: [candidate] })],
            managedMachineProjection: { state: 'unavailable' as const, rowCount: 0 },
            ...(placement === 'recent' ? { recentMachines: [candidate] } : {}),
            ...(placement === 'favorites' ? { favoriteMachines: [candidate] } : {}),
        };
        const read = () => buildMachineDestinationModel(params);
        recordMachineRequestFailed({ serverId: 'other-home', accountId: fixtureScope.accountId, machineId: candidate.id, observedAtMs: 1 });
        expect(read().soleSelectableDestination?.machine).toBe(candidate);
        recordMachineRequestFailed({ ...fixtureScope, machineId: candidate.id, observedAtMs: 2 });
        expect(read()).toMatchObject({ machineRowCount: 1, destinationSetSettled: true, soleSelectableDestination: null });
        recordMachineRequestSucceeded({ ...fixtureScope, machineId: candidate.id, observedAtMs: 3 });
        expect(read().soleSelectableDestination?.machine).toBe(candidate);
    });
    it('does not shortcut a Session while New machine offer availability is unobserved', () => {
        const unobserved = buildMachineDestinationModel({ purpose: 'session', groups: [group()] });
        expect(unobserved.destinationSetSettled).toBe(false);
        expect(unobserved.soleSelectableDestination).toBeNull();
        const optedOut = buildMachineDestinationModel({ purpose: 'session', groups: [group()],
            managedMachineProjection: { state: 'unavailable', rowCount: 0 } });
        expect(optedOut.destinationSetSettled).toBe(true);
        expect(optedOut.soleSelectableDestination?.machine.id).toBe('machine-1');
        expect(buildMachineDestinationModel({ purpose: 'boards', groups: [group()] }).destinationSetSettled).toBe(true);
    });
    it.each(['finite', 'service-start'] as const)('retains the exact status explanation and load for %s presentation', (purpose) => {
        const full = {
            eligible: true as const,
            candidate: { serverId: 'server-a', machineId: 'machine-1' },
            load: { kind: 'known' as const, running: 4, queued: 9, accepting: true, runAtMost: 4 },
            explanation: 'eligible' as const,
        };
        const unknown = { ...full, load: { kind: 'unknown' as const }, explanation: 'load_unknown' as const };
        const refused = {
            eligible: false as const, candidate: null,
            load: { kind: 'unknown' as const }, explanation: 'capability_unknown' as const,
        };
        for (const worker of [full, unknown]) {
            expect(resolveMachineDestinationPurposeEligibility(purpose, { ownership: 'owned', worker }, machine('machine-1')))
                .toEqual({ eligible: true, worker });
        }
        expect(resolveMachineDestinationPurposeEligibility(purpose, { ownership: 'owned', worker: refused }, machine('machine-1')))
            .toEqual({ eligible: false, reason: 'worker_refused', worker: refused });
    });

    it.each(['finite', 'service-start'] as const)('offers copy setup without admitting an unrunnable %s worker', purpose => {
        const worker = { eligible: false, candidate: null, load: { kind: 'unknown' }, explanation: 'worker_copy_missing',
            workerCopy: { serverId: 'server-a', sourceWorkspaceRefId: 'source', sourceMachineId: 'source-machine',
                targetMachineId: 'machine-1' } } satisfies ProjectWorkerStatusResultV1;
        const facts = { ownership: 'owned', worker } as const;
        expect(resolveMachineDestinationPurposeEligibility(purpose, facts, machine('machine-1')))
            .toMatchObject({ eligible: false, reason: 'needs_copy', action: { kind: 'worker_copy_setup', workerCopy: worker.workerCopy } });
        expect(buildMachineDestinationModel({ purpose, groups: [group()], resolveMachinePlacementFacts: () => facts })
            .soleSelectableDestination).toBeNull();
        expect(resolveMachineDestinationPurposeEligibility(purpose, facts, machine('machine-1', { active: false, activeAt: 0 })))
            .not.toHaveProperty('action');
        expect(resolveMachineDestinationPurposeEligibility(purpose, { ownership: 'owned', worker: {
            eligible: false, candidate: null, load: { kind: 'unknown' }, explanation: 'forbidden',
        } }, machine('machine-1'))).toEqual({ eligible: false, reason: 'worker_refused', worker: {
            eligible: false, candidate: null, load: { kind: 'unknown' }, explanation: 'forbidden',
        } });
    });

    it('does not infer finite capability or load from Session presence', () => {
        const model = buildMachineDestinationModel({ purpose: 'finite', groups: [group()] });
        expect(model.soleSelectableDestination).toBeNull();
    });

    it('keeps eligible unknown and busy load as exact finite candidates', () => {
        for (const load of [{ kind: 'unknown' }, { kind: 'known', running: 4, queued: 9, accepting: true, runAtMost: 4 }] as const) {
            const model = buildMachineDestinationModel({
                purpose: 'finite', groups: [group()],
                resolveMachinePlacementFacts: () => ({ ownership: 'owned', worker: eligibleWorker('machine-1', load) }),
            });
            expect(model.soleSelectableDestination?.machine.id).toBe('machine-1');
        }
    });

    it('keeps a ready shared permission visible but disabled until current content is hydrated', () => {
        const shared = machine('shared', { isShared: true, metadata: null, access: {
            custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use', resourceMode: 'e2ee', accessState: 'ready',
        } });
        const model = buildMachineDestinationModel({ groups: [group({ machines: [shared] })],
            managedMachineProjection: { state: 'unavailable', rowCount: 0 } });
        expect(model.machineRowCount).toBe(1);
        expect(model.soleSelectableDestination).toBeNull();
        expect(resolveMachineDestinationPurposeEligibility('session', undefined, shared)).toEqual({ eligible: false, reason: 'content_unavailable' });
    });
    it.each([false, true])('does not let worker admission select an offline Machine (shared=%s)', isShared => {
        const candidate = machine('offline', { active: false, activeAt: 0, isShared, access: {
            custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use', resourceMode: 'plain', accessState: 'ready',
        } });
        expect(buildMachineDestinationModel({ purpose: 'finite', groups: [group({ machines: [candidate] })],
            resolveMachinePlacementFacts: () => ({ ownership: isShared ? 'shared' : 'owned', worker: eligibleWorker(candidate.id) }),
        }).soleSelectableDestination).toBeNull();
    });

    it.each(['session', 'finite', 'service-start', 'workflow', 'trigger', 'background', 'boards'] as const)('admits a ready shared exact target for %s', (purpose) => {
        const shared = machine('shared', { isShared: true, access: {
            custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use',
            resourceMode: 'plain', accessState: 'ready',
        } });
        expect(buildMachineDestinationModel({ groups: [group({ machines: [shared] })], purpose,
            managedMachineProjection: { state: 'unavailable', rowCount: 0 },
            resolveMachinePlacementFacts: () => ({ ownership: 'shared', worker: eligibleWorker('shared') }),
        })
            .soleSelectableDestination?.machine).toBe(shared);
    });

    it.each(['asleep', 'starting'] as const)('admits a shared %s Session from its admitted wake fact', managedWake => {
        const shared = machine('shared', { active: false, activeAt: 0, isShared: true, access: {
            custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use',
            resourceMode: 'plain', accessState: 'ready',
        }, managedInputRuntime: { nativeReady: false, wakeState: managedWake, newSessionWake: { kind: 'available' } } });
        const facts = { ownership: 'shared', managedWake } as const;
        const eligibility = resolveMachineDestinationPurposeEligibility('session', facts, shared);
        expect(eligibility).toEqual({ eligible: true, managedWake });
        expect(describeMachineDestinationWorkerFacts(eligibility, undefined, 'session', 'Shared machine'))
            .toBe(managedWake === 'asleep' ? t('managedWake.startsOnSend')
                : t('managedWake.starting', { machine: 'Shared machine' }));
        expect(buildMachineDestinationModel({ purpose: 'session', groups: [group({ machines: [shared] })],
            managedMachineProjection: { state: 'unavailable', rowCount: 0 },
            resolveMachinePlacementFacts: () => facts }).soleSelectableDestination?.machine).toBe(shared);
        const selectable = (candidate: Machine) => buildMachineDestinationModel({ purpose: 'session',
            groups: [group({ machines: [candidate] })], managedMachineProjection: { state: 'unavailable', rowCount: 0 },
            resolveMachinePlacementFacts: () => facts }).soleSelectableDestination;
        expect(selectable({ ...shared, managedInputRuntime: undefined })).toBeNull();
        for (const blocked of [
            { ...shared, metadata: null },
            { ...shared, access: { ...shared.access!, accessState: 'key_pending' as const } },
            { ...shared, revokedAt: 1 },
            { ...shared, replacedByMachineId: 'replacement' },
        ]) expect(selectable(blocked)).toBeNull();
    });

    it.each(['key_pending', 'refused'] as const)('does not turn online shared %s into a usable destination', (accessState) => {
        const model = buildMachineDestinationModel({ groups: [group({ machines: [machine('shared', {
            isShared: true, access: { custodian: { accountId: 'alice', displayName: 'Alice' },
                role: 'use', resourceMode: 'e2ee', accessState },
        })] })], managedMachineProjection: { state: 'unavailable', rowCount: 0 } });
        expect(model.machineRowCount).toBe(1);
        expect(model.soleSelectableDestination).toBeNull();
    });
    it('keeps an online unreadable Machine visible without auto-selecting it', () => {
        const model = buildMachineDestinationModel({
            managedMachineProjection: { state: 'unavailable', rowCount: 0 },
            groups: [group({ machines: [machine('locked', {
                metadata: null,
                availability: { kind: 'locked', reason: 'encryption_material_unavailable' },
            })] })],
        });
        expect(model.machineRowCount).toBe(1);
        expect(model.soleSelectableDestination).toBeNull();
    });
    it('retains an unreadable owned Machine as a Board item, not an execution destination', () => {
        const locked = machine('locked', { availability: {
            kind: 'locked', reason: 'encryption_material_unavailable',
        } });
        expect(resolveMachineDestinationPurposeEligibility('boards', undefined, locked)).toEqual({ eligible: true });
        expect(resolveMachineDestinationPurposeEligibility('session', undefined, locked).eligible).toBe(false);
    });
    it('does not offer temporary Session destinations to workflow or finite purposes', () => {
        for (const purpose of ['workflow', 'trigger', 'background', 'boards', 'finite', 'service-start'] as const) {
            const model = buildMachineDestinationModel({
                purpose,
                groups: [group()],
                temporaryComputerProjection: { state: 'available', rowCount: 2 },
            });
            expect(model.temporaryComputerRowCount).toBe(0);
        }
    });
    it('offers the single admissible Machine only when the whole choice set is settled', () => {
        const model = buildMachineDestinationModel({
            managedMachineProjection: { state: 'unavailable', rowCount: 0 },
            groups: [group()],
            poolGroups: [{ serverId: 'server-a', pools: [], status: 'idle', projectionReady: true }],
        });

        expect(model.destinationRowCount).toBe(1);
        expect(model.destinationSetSettled).toBe(true);
        expect(model.soleSelectableDestination).toEqual({
            serverId: 'server-a',
            machine: expect.objectContaining({ id: 'machine-1' }),
        });
    });

    it('counts a Machine Pool row as a destination, so one Machine plus one Pool is not a shortcut', () => {
        const model = buildMachineDestinationModel({
            managedMachineProjection: { state: 'unavailable', rowCount: 0 },
            groups: [group()],
            poolGroups: [{ serverId: 'server-a', pools: [pool('pool-a')], status: 'idle', projectionReady: true }],
        });

        expect(model.destinationRowCount).toBe(2);
        expect(model.poolRowCount).toBe(1);
        expect(model.soleSelectableDestination).toBeNull();
    });

    it('counts every available Temporary computer artifact in the same destination set', () => {
        const model = buildMachineDestinationModel({
            managedMachineProjection: { state: 'unavailable', rowCount: 0 },
            groups: [group()],
            poolGroups: [{ serverId: 'server-a', pools: [], status: 'idle', projectionReady: true }],
            temporaryComputerProjection: { state: 'available', rowCount: 2 },
        });

        expect(model.destinationRowCount).toBe(3);
        expect(model.temporaryComputerRowCount).toBe(2);
        expect(model.destinationSetSettled).toBe(true);
        expect(model.soleSelectableDestination).toBeNull();
    });

    it('keeps destination completeness pending until Temporary computer availability settles', () => {
        const model = buildMachineDestinationModel({
            managedMachineProjection: { state: 'unavailable', rowCount: 0 },
            groups: [group()],
            poolGroups: [{ serverId: 'server-a', pools: [], status: 'idle', projectionReady: true }],
            temporaryComputerProjection: { state: 'pending', rowCount: 0 },
        });

        expect(model.destinationRowCount).toBe(1);
        expect(model.temporaryComputerRowCount).toBe(0);
        expect(model.destinationSetSettled).toBe(false);
        expect(model.soleSelectableDestination).toBeNull();
    });

    it('treats a known unavailable Temporary computer as an empty settled destination source', () => {
        const model = buildMachineDestinationModel({
            managedMachineProjection: { state: 'unavailable', rowCount: 0 },
            groups: [group()],
            poolGroups: [{ serverId: 'server-a', pools: [], status: 'idle', projectionReady: true }],
            temporaryComputerProjection: { state: 'empty', rowCount: 0 },
        });

        expect(model.destinationRowCount).toBe(1);
        expect(model.destinationSetSettled).toBe(true);
        expect(model.soleSelectableDestination?.machine.id).toBe('machine-1');
    });

    it('treats an unresolved Pool answer as an incomplete set rather than a known-empty one', () => {
        const model = buildMachineDestinationModel({
            managedMachineProjection: { state: 'unavailable', rowCount: 0 },
            groups: [group()],
            poolGroups: [{ serverId: 'server-a', pools: [], status: 'error', projectionReady: false }],
        });

        expect(model.destinationSetSettled).toBe(false);
        expect(model.soleSelectableDestination).toBeNull();
    });

    it.each([
        { label: 'missing', poolGroups: [] },
        {
            label: 'failed',
            poolGroups: [{ serverId: 'server-a', pools: [], status: 'error' as const, projectionReady: true }],
        },
    ])('does not treat a $label Pool projection as a known-empty destination set', ({ poolGroups }) => {
        const model = buildMachineDestinationModel({ groups: [group()], poolGroups,
            managedMachineProjection: { state: 'unavailable', rowCount: 0 } });

        expect(model.destinationSetSettled).toBe(false);
        expect(model.soleSelectableDestination).toBeNull();
    });

    it('waits for a loading Home before deciding the set is complete', () => {
        const model = buildMachineDestinationModel({
            managedMachineProjection: { state: 'unavailable', rowCount: 0 },
            groups: [
                group(),
                group({ serverId: 'server-b', loading: true, machines: [] }),
            ],
            poolGroups: [
                { serverId: 'server-a', pools: [], status: 'idle', projectionReady: true },
                { serverId: 'server-b', pools: [], status: 'idle', projectionReady: true },
            ],
        });

        expect(model.destinationSetSettled).toBe(false);
        expect(model.soleSelectableDestination).toBeNull();
    });

    it('keeps a Home with a failed Machine-list refresh out of the settled destination set', () => {
        const failedGroup = { ...group(), error: true };
        const model = buildMachineDestinationModel({
            managedMachineProjection: { state: 'unavailable', rowCount: 0 },
            groups: [failedGroup],
            poolGroups: [{ serverId: 'server-a', pools: [pool('pool-a')], status: 'idle', projectionReady: true }],
        });

        expect(model.destinationSetSettled).toBe(false);
        expect(model.soleSelectableDestination).toBeNull();
    });

    it('excludes an offline-only Home from the shortcut while still counting its rendered row', () => {
        const model = buildMachineDestinationModel({
            managedMachineProjection: { state: 'unavailable', rowCount: 0 },
            groups: [group({ machines: [machine('machine-1', { active: false, activeAt: 0 })] })],
            poolGroups: [{ serverId: 'server-a', pools: [], status: 'idle', projectionReady: true }],
        });

        expect(model.destinationRowCount).toBe(1);
        expect(model.soleSelectableDestination).toBeNull();
    });

    it('does not count a revoked Machine that the single-Home list never renders', () => {
        const model = buildMachineDestinationModel({
            managedMachineProjection: { state: 'unavailable', rowCount: 0 },
            groups: [group({
                machines: [machine('machine-1'), machine('machine-revoked', { revokedAt: 5 })],
            })],
            poolGroups: [{ serverId: 'server-a', pools: [], status: 'idle', projectionReady: true }],
        });

        expect(model.machineRowCount).toBe(1);
        expect(model.soleSelectableDestination?.machine.id).toBe('machine-1');
    });
});

describe('describeMachineDestinationWorkerFacts', () => {
    const subject = { scriptName: 'test', memoryDemandBytes: 8 * 1024 ** 3 };

    it('says a known idle worker is free and a full one queues there, never inventing load for unknown', () => {
        expect(describeMachineDestinationWorkerFacts(resolveMachineDestinationPurposeEligibility('finite', {
            ownership: 'owned', worker: eligibleWorker('idle', { kind: 'known', running: 0, queued: 0, accepting: true, runAtMost: null }),
        }))).toBe(t('projectWorkers.free'));
        expect(describeMachineDestinationWorkerFacts(resolveMachineDestinationPurposeEligibility('finite', {
            ownership: 'owned', worker: eligibleWorker('full', { kind: 'known', running: 2, queued: 1, accepting: true, runAtMost: 2 }),
        }))).toBe([t('projectWorkers.runningCount', { count: 2 }), t('projectWorkers.queuedCount', { count: 1 }), t('projectWorkers.waitsThere')].join(' · '));
        expect(describeMachineDestinationWorkerFacts(resolveMachineDestinationPurposeEligibility('finite', {
            ownership: 'owned', worker: eligibleWorker('unknown'),
        }))).toBe(t('projectWorkers.loadUnknown'));
    });

    it('keeps service-start load visible without claiming it waits for finite capacity or accepting policy', () => {
        for (const accepting of [false, true]) {
            const eligibility = resolveMachineDestinationPurposeEligibility('service-start', {
                ownership: 'owned', worker: eligibleWorker('full', {
                    kind: 'known', running: 2, queued: 1, accepting, runAtMost: 2,
                }),
            });
            expect(eligibility.eligible).toBe(true);
            const detail = describeMachineDestinationWorkerFacts(eligibility, undefined, 'service-start');
            expect(detail).toBe([t('projectWorkers.runningCount', { count: 2 }), t('projectWorkers.queuedCount', { count: 1 })].join(' · '));
        }
    });

    it('says an asleep worker starts for this run and a starting one is starting, never offline', () => {
        const wake = (managedWake: 'asleep' | 'starting') => describeMachineDestinationWorkerFacts(
            resolveMachineDestinationPurposeEligibility('finite', { ownership: 'owned', managedWake }), { scriptName: 'test' }, 'finite', 'hz-build-2');
        expect(wake('asleep')).toBe(`${t('managedPower.asleep')} · ${t('projectWorkers.wakeForRun')}`);
        expect(wake('starting')).toBe(`${t('managedWake.starting', { machine: 'hz-build-2' })} · ${t('projectWorkers.runAfterWake')}`);
    });

    it('adds the last clean copy to an eligible worker only when that fact is known', () => {
        const idle = { kind: 'known' as const, running: 0, queued: 0, accepting: true, runAtMost: null };
        const fresh = describeMachineDestinationWorkerFacts(resolveMachineDestinationPurposeEligibility('finite', {
            ownership: 'owned', worker: { ...eligibleWorker('fresh', idle), lastCleanSyncAtMs: Date.now() - 5 * 60_000 },
        }));
        expect(fresh).toContain(t('projectWorkers.free'));
        expect(fresh).toContain(t('projectWorkers.freshCopySynced', { time: formatRelativeTimeShort(Date.now() - 5 * 60_000, Date.now()) }));
        const unknown = describeMachineDestinationWorkerFacts(resolveMachineDestinationPurposeEligibility('finite', {
            ownership: 'owned', worker: { ...eligibleWorker('unknown-sync', idle), lastCleanSyncAtMs: null },
        }));
        expect(unknown).toBe(t('projectWorkers.free'));
    });

    it('names the exact refusal, including the declared memory need, and leaves non-worker purposes alone', () => {
        const refused = (explanation: Extract<ProjectWorkerStatusResultV1, { eligible: false }>['explanation'],
            observedMemory?: ProjectWorkerStatusResultV1['observedMemory']) =>
            resolveMachineDestinationPurposeEligibility('finite', {
                ownership: 'owned', worker: ProjectWorkerStatusResultV1Schema.parse({
                    eligible: false, candidate: null, load: { kind: 'unknown' }, explanation,
                    ...(observedMemory ? { observedMemory } : {}),
                }),
            });
        expect(describeMachineDestinationWorkerFacts(refused('not_accepting'))).toBe(t('projectWorkers.notAccepting'));
        expect(describeMachineDestinationWorkerFacts(refused('draining'))).toBe(t('projectWorkers.draining'));
        expect(describeMachineDestinationWorkerFacts(refused('forbidden'))).toBe(t('projectWorkers.accessRefused'));
        expect(describeMachineDestinationWorkerFacts(refused('memory_insufficient'), subject))
            .toBe(t('projectWorkers.tooSmall', { script: 'test', need: '8 GB' }));
        const observedMemory = { totalBytes: 4 * 1024 ** 3, availableBytes: 1024 ** 3 };
        const interpolation = { script: 'test', need: '8 GB', available: '4 GB' };
        const tooSmall = describeMachineDestinationWorkerFacts(refused('memory_insufficient', observedMemory), subject);
        expect(tooSmall).toBe(t('projectWorkers.tooSmall', interpolation));
        // The numeric fact is the contract, not the translated wording. Comparing
        // only t(...) would miss a locale that also drops the available argument.
        expect(tooSmall).toContain('4 GB');
        expect(tooSmall).not.toContain('1 GB');
        expect(describeMachineDestinationWorkerFacts(refused('memory_unavailable'), subject))
            .toBe(t('projectWorkers.memoryUnavailable'));
        expect(describeMachineDestinationWorkerFacts(resolveMachineDestinationPurposeEligibility('finite', { ownership: 'owned' })))
            .toBe(t('projectWorkers.loading'));
        expect(describeMachineDestinationWorkerFacts(resolveMachineDestinationPurposeEligibility('finite', { ownership: 'owned', workerStatusFailed: true })))
            .toBe(t('projectWorkers.statusUnavailable'));
        expect(describeMachineDestinationWorkerFacts(resolveMachineDestinationPurposeEligibility('session'))).toBeUndefined();
    });
});
