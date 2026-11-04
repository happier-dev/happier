import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as childProcess from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol';
import { MachineGuardPolicyV1Schema, type MachineGuardPolicyV1 } from '@happier-dev/protocol/machines/guard/guardPolicyV1';
import { MachineProcessesCleanUpInputV1Schema } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import { MachineGuardActivityEntryV1Schema, MachineGuardActivityListV1Schema } from '@happier-dev/protocol/machines/guard/activityV1';
import { MachineGuardWatchResultV1Schema } from '@happier-dev/protocol/machines/guard/guardRpcV1';
import { MachinePublishedResourceSummaryV1Schema } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';

import { createManagedActivityInventory, createLiveWorkProducerGroup } from '../lifecycle/managedActivity';
import { createSessionLiveWorkProducer } from '../lifecycle/sessionLiveWorkProducer';
import { createProcessOwnershipRuntime } from '../processes/ownership/processOwnershipRuntime';
import { localServiceProcfsFixture } from '../local/services/inventory/platform/censusFixture.testkit';
import { createMachineResourcesPolicyRuntime } from '../resources/machineResourcesPolicy';
import { createMachineResourceSummary } from '../resources/machineResourceSummary';
import { createMachineVitalsSampler } from '../vitals/createMachineVitalsSampler';
import { createMinuteHistoryStore } from '../vitals/history/minuteHistoryStore';
import { createKeepAwake } from '@/integrations/keepAwake';
import { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { createManagedServiceProcessSupervisorHost } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { authorizeResolvedProjectExecLaunchForHost, createProjectNativeEnvironmentIoForHost } from '@/plugins/runtime/invocation/services/exec';
import * as nativeTermination from '@/processes/terminate/terminateProcessTree';
import { listHappierProcessRoots } from '../processes/roots/listHappierProcessRoots';
import { parseProcessOwnerTag, PROCESS_OWNER_ENV_KEY } from '@/processes/ownerTag';
import { normalizeLocalServiceScan } from '../local/services/inventory/scanner';
import { createReadGuardFacts } from './readGuardFacts';
import type { GuardFacts } from './guardPlanner';
import type { ActivityLog } from './activityLog';
import type { GuardPolicyWork } from './guardRuntime';
import { createLeftBehindActuator } from './actuators/leftBehind';
import { createGuardLeftBehindFixture, guardLeftBehindAttribution } from './actuators/leftBehind.testkit';
import { createProcessActionExecutor } from '../processes/actions/processActionExecutor';
import { processRef } from '../processes/view/processRef';
import { createIdleTerminalPolicy } from './idleTerminalPolicy';
import { createIdleTerminalPolicyFixture } from './idleTerminalPolicy.testkit';
import { createDaemonGuard, type DaemonGuard } from './createDaemonGuard';
import { evaluateSessionEligibility } from './sessionEligibility';
import type { TrackedSession } from '../types';
import { SessionGuardNoticeStateV1Schema, type SessionGuardNoticeStateV1 } from '@happier-dev/protocol/machines/guard/sessionGuardStateV1';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
beforeAll(async () => { runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
    runtimeOptions: { pluginIds: ['happier.agent.codex'] } }); });
afterAll(async () => { await runtime?.dispose(); });

const epoch = Date.UTC(2026, 9, 10);
const target = { serverId: 'home', machineId: 'machine', installationId: 'installation' };
const requester = { serverId: 'home', accountId: 'alice', isCustodian: true };

// Genuine native IO modules: no internal owner, planner, custody or projection is replaced.
vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock('@/processes/terminate/terminateProcessTree', { spy: true });

describe('daemon Guard composition at the real minute, Activity and summary owners', () => {
    let directory: string;
    const cleanup: Array<() => void | Promise<void>> = [];
    beforeEach(async () => { vi.useFakeTimers(); vi.setSystemTime(epoch); directory = await mkdtemp(join(tmpdir(), 'happier-daemon-guard-')); });
    afterEach(async () => {
        for (const stop of cleanup.splice(0).reverse()) await stop();
        vi.restoreAllMocks(); vi.useRealTimers(); await rm(directory, { recursive: true, force: true });
    });

    async function setup(signal?: AbortSignal, policyAvailable = true, projectService = false, auxiliary?: Readonly<{
        readPolicy(): MachineGuardPolicyV1;
        ownership: ReturnType<typeof createProcessOwnershipRuntime>;
        createPolicyWork(activityLog: ActivityLog): GuardPolicyWork & Readonly<{ refreshOnTick(): void; stop(): void }>;
    }>, idleSession = false) {
        let guard: DaemonGuard | undefined;
        let pressure: 'critical' | 'calm' = projectService ? 'calm' : 'critical';
        let available = 100;
        let missingVitals = false;
        let present = true;
        let nativeReads = 0;
        let factsReads = 0;
        let stops = 0;
        let working = projectService;
        let connections = 0;
        let activityReadBoundary: (() => Promise<void>) | undefined;
        let factsReadBoundary: (() => Promise<void>) | undefined;
        const notices: SessionGuardNoticeStateV1[] = [];
        const workspace = { id: 'workspace', rootPath: '/project', serverId: target.serverId, machineId: target.machineId, createdAtMs: epoch - 60000 };
        const declaration = { workspaceRefId: workspace.id, selection: { kind: 'manifest' as const, name: 'dev-server' } };
        const originalStart = { machineId: target.machineId, targetId: 'project:workspace:manifest:dev-server',
            workspace: { serverId: target.serverId, machineId: target.machineId, workspaceId: workspace.id, rootPath: workspace.rootPath }, declaration,
            expectedEffectDigest: 'original-reviewed-declaration' };
        let nativeEnvironment: Readonly<Record<string, string | undefined>> = {};
        const serviceOwner = projectService ? createManagedServicesOwner({
            processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon', platform: 'darwin',
                now: Date.now, createInstanceId: () => 'native-project-instance' }),
            // Project native custody does not use plugin-managed dependency installation.
            dependencies: {} as never, resolveScope: scope => scope,
        }) : undefined;
        if (serviceOwner) {
            // Native spawn and termination IO only; real supervisor and retained Project custody remain underneath.
            const child = new childProcess.ChildProcess();
            Object.defineProperties(child, { pid: { value: 1001 }, stdin: { value: new PassThrough() },
                stdout: { value: new PassThrough() }, stderr: { value: new PassThrough() } });
            vi.mocked(childProcess.spawn).mockImplementation((_command, _args, options) => {
                nativeEnvironment = options.env ?? {}; return child;
            });
            vi.spyOn(nativeTermination, 'terminateProcessTree').mockImplementation(async () => {
                stops++; present = false; Object.defineProperty(child, 'exitCode', { value: 0 });
                child.emit('exit', 0, null); child.emit('close', 0, null);
            });
            await serviceOwner.superviseProject({ kind: 'workspace', workspace, declaration, cwd: '/project/nested',
                requester: { ...target, accountId: requester.accountId }, serviceId: originalStart.targetId,
                specIdentity: 'original-reviewed-declaration', isCurrent: () => true,
                processSpec: { mode: { kind: 'managedSpawn', endpointNone: true } },
                authorizeLaunch: ({ signal: launchSignal }) => authorizeResolvedProjectExecLaunchForHost({
                    signal: launchSignal, assertCurrent() {}, projectLaunch: { status: 'ready', reviewedEffectDigest: 'original-reviewed-declaration',
                        environment: { selection: { kind: 'host' }, root: workspace.rootPath, platform: 'linux',
                            io: createProjectNativeEnvironmentIoForHost({ resolveTool: async () => null }) } },
                    launch: { command: '/native/dev-server', args: [], cwd: '/project/nested', env: {}, release() {} },
                }),
            }); cleanup.push(() => serviceOwner.dispose());
        }
        const intervals: number[] = [];
        const sampler = createMachineVitalsSampler({ nowMs: Date.now, monotonicMs: Date.now,
            historyStore: await createMinuteHistoryStore({ directory: join(directory, 'minutes'), nowMs: Date.now }),
            // OS counter boundary; all minute aggregation and execution logic beneath it are real.
            readers: { read: async input => {
                intervals.push(input.intervalMs);
                if (missingVitals) return { state: 'unavailable', reason: 'reader_failed' };
                return { state: 'reporting', host: { logicalCores: 1, memoryTotalBytes: 1000, bootedAt: epoch - 60000 },
                    sample: { v: 1, sampledAt: input.sampledAt, intervalMs: input.intervalMs,
                        cpu: { reported: false, reason: 'unavailable' }, memory: { reported: true, totalBytes: 1000,
                            availableBytes: available, usedBytes: 1000 - available, pressure: { level: pressure, source: 'events' } },
                        disk: { reported: false, reason: 'unavailable' }, network: { reported: false, reason: 'unavailable' } },
                    minuteCounters: { monotonicMs: input.monotonicMs, cpu: null, network: null } };
            } }, onTick: () => guard?.refreshOnTick(),
        }); await sampler.start(); cleanup.push(() => sampler.stop());
        const summary = createMachineResourceSummary({ sampler, nowMs: Date.now, readNearlyFull: () => null,
            onError: error => { throw error; } }); cleanup.push(() => summary.stop());
        let metadataVersion = 1;
        let metadata: Record<string, unknown> = policyAvailable ? { resourcesPolicyV1: { v: 1,
            guard: auxiliary?.readPolicy() ?? { memoryGuard: { enabled: !idleSession, sustainMs: 60000 } } } }
            : { resourcesPolicyV1: { v: 2 } };
        const policy = createMachineResourcesPolicyRuntime({ port: {
            read: async () => ({ status: 'ready', metadataVersion, metadata: auxiliary
                ? { resourcesPolicyV1: { v: 1, guard: auxiliary.readPolicy() } } : metadata }),
            compareAndSwap: async input => {
                if (!idleSession) return { status: 'unavailable' };
                metadata = input.metadata; metadataVersion++;
                return { status: 'applied', metadata, metadataVersion };
            },
        } }); await policy.reload(); cleanup.push(() => policy.stop());
        const workspaceSession: TrackedSession = { pid: idleSession ? 1001 : 2001, happySessionId: 'workspace-session',
            processStartTimeMs: 123450, startedBy: 'daemon', spawnOptions: { directory: '/project/nested' } };
        const sessionProducer = createSessionLiveWorkProducer({
            readSessions: () => projectService || idleSession ? [workspaceSession] : [],
            // Session activity RPC is a network boundary, reconciled by the real inventory producer.
            readActivity: async () => {
                await activityReadBoundary?.();
                return { session: working ? 'active' : 'settled', input: 'settled', agents: 'settled', attention: 'settled', settledAt: epoch };
            },
        });
        const sessionActivity = createLiveWorkProducerGroup(() => [sessionProducer]);
        cleanup.push(() => sessionActivity.dispose());
        const browserOwner = {};
        // Native sidecar residency is a process boundary. Its disappearance is
        // a material item change, not an unchanged Session inventory notification.
        const browserResidency = !projectService && !idleSession ? [{
            read: () => ({ coverage: 'complete' as const, items: present ? [{
                category: 'service' as const, ownerRef: browserOwner, attribution: { kind: 'unknown' as const },
                state: 'settled' as const, settledAt: epoch - 60000,
            }] : [] }),
            subscribe: sessionProducer.subscribe,
        }] : [];
        const inventory = createManagedActivityInventory({ now: Date.now,
            producers: [sessionActivity, ...browserResidency, ...(serviceOwner ? [serviceOwner.activity] : [])] }); cleanup.push(() => inventory.dispose());
        const procfs = () => localServiceProcfsFixture(present ? [{ pid: 1001 }] : []);
        const serviceTag = parseProcessOwnerTag(nativeEnvironment[PROCESS_OWNER_ENV_KEY]);
        if (serviceOwner && !serviceTag) throw new Error('Native service launch did not retain its process owner');
        const daemonScopeKey = serviceTag?.daemonScopeKey ?? '123456789abc';
        const ownership = createProcessOwnershipRuntime({ daemonScopeKey, platform: 'linux',
            censusDependencies: { platform: 'linux', linuxBoundary: {
                readdir: async path => { nativeReads++; return procfs().readdir(path); },
                readFile: async path => {
                    if (path === '/proc/self/auxv') { const value = Buffer.alloc(32); value.writeBigUInt64LE(6n, 0); value.writeBigUInt64LE(4096n, 8); return value; }
                    if (projectService && path === '/proc/1001/environ') return `${PROCESS_OWNER_ENV_KEY}=${nativeEnvironment[PROCESS_OWNER_ENV_KEY]}\0`;
                    return procfs().readFile(path);
                }, readlink: async path => procfs().readlink(path),
            } },
            listRoots: snapshot => serviceOwner ? listHappierProcessRoots({ snapshot, platform: 'linux',
                daemonScopeKey,
                managedServices: serviceOwner.readProcessRoots() }) : snapshot.rows.filter(row => row.pid === 1001).map(row => ({
                pid: row.pid, start: row.start, owner: idleSession ? { kind: 'session', sessionId: workspaceSession.happySessionId! }
                    : { kind: 'browser_sidecar' }, live: true, ownerCreatedAtMs: epoch - 60000,
                stop: async () => { stops++; },
            })),
        });
        const keepAwake = createKeepAwake({ platform: 'linux', exists: () => false }); cleanup.push(() => keepAwake.release());
        const projectFacts = createReadGuardFacts({ readBrowsers: () => [], trackedSessions: () => idleSession ? [workspaceSession] : [], readInventory: () => inventory.read(),
            readServiceTargets: () => serviceOwner?.readResourceTargets() ?? [], readSessionEligibility: async (tracked, liveWork) => {
                if (!idleSession) throw new Error('No owned Session root');
                return (await evaluateSessionEligibility({ tracked, inventory: liveWork, draft: { status: 'absent' }, resume: {
                    sessionId: tracked.happySessionId!, rawSession: { machineId: target.machineId, path: '/project' },
                    metadata: { runtimeDescriptorV1: { v: 1 as const, agentId: 'codex', agent: { backendMode: 'appServer' } }, machineId: target.machineId, path: '/project', flavor: 'codex', codexSessionId: 'native' },
                } }));
            },
            readServices: async () => {
                // Native socket counters only; real normalization joins the exact owner and generation.
                const owners = await ownership.readOwners({ freshness: 'shared' });
                if (owners.status !== 'ok') throw new Error('Native ownership unavailable');
                return normalizeLocalServiceScan({ machineId: target.machineId, now: Date.now(), previous: null, workspaces: [], ownership: owners.rows,
                    listeners: present ? [{ pid: 1001, address: '127.0.0.1', port: 5173, protocol: 'tcp', establishedConnections: connections }] : [],
                    processes: new Map(owners.snapshot.rows.map(row => [row.pid, { pid: row.pid, ppid: row.ppid ?? undefined,
                        processStartTimeMs: row.start.startTimeMs, censusRow: row, command: 'vite', processOwnership: 'self' as const }])) });
            } });
        const readFacts = async (owners: GuardFacts['ownership'], readSignal?: AbortSignal): Promise<GuardFacts> => {
            factsReads++;
            await factsReadBoundary?.();
            return projectService || idleSession
            ? projectFacts({ ownership: owners, inventory: await inventory.read(), signal: readSignal }) : ({ ownership: owners,
            inventory: await inventory.read(), targets: owners.status === 'ok' ? owners.roots.map(root => ({
                kind: 'browser', root, ownerRef: root, label: 'private browser', idle: true, settledAt: epoch - 60000,
                wayBack: [{ label: 'reopen', actionId: 'browser.view.open', input: {} }],
            })) : [] });
        };
        guard = await createDaemonGuard({ activeServerDir: directory, sampler, summary, policy, inventory,
            ownership: auxiliary?.ownership ?? ownership, keepAwake,
            ...(auxiliary ? { createPolicyWork: auxiliary.createPolicyWork } : {}),
            readFacts, readTarget: () => target, readLeftBehind: () => ({ count: 0, footprintBytes: 0 }),
            ceilingCapability: { status: 'unavailable', reason: 'no_user_manager' }, signal, nowMs: Date.now, platform: 'linux',
            // Native stop and notification admission are genuine outward system boundaries.
            stopTarget: async candidate => { await candidate.root.stop?.(); return { status: 'stopped' }; },
            notice: async (_candidate, state) => { notices.push(SessionGuardNoticeStateV1Schema.parse(state)); return true; },
            notifyEpisode: async () => {}, onError: error => { throw error; },
        }); cleanup.push(() => guard!.stop());
        const drain = async () => {
            await sampler.start();
            for (let read = 0; read < 4; read++) { await guard!.activityLog.list({ range: 'today' }); for (let turn = 0; turn < 20; turn++) await Promise.resolve(); }
        }; await drain();
        return { guard, sampler, summary, policy, inventory, intervals, drain, originalStart, notices,
            duringFactsRead: (boundary: () => Promise<void>) => { factsReadBoundary = boundary; },
            async metadataOnlyChange() { metadataVersion++; await policy.reload(); },
            holdActivity() {
                let entered!: () => void;
                let finish!: () => void;
                const started = new Promise<void>(resolve => { entered = resolve; });
                const reply = new Promise<void>(resolve => { finish = resolve; });
                activityReadBoundary = () => { entered(); return reply; };
                sessionProducer.notifyChanged();
                return { started, finish };
            },
            working: (value: boolean) => { working = value; sessionProducer.notifyChanged(); },
            connections: (value: number) => { connections = value; guard!.refreshOnTick(); },
            gone: () => { present = false; sessionProducer.notifyChanged(); }, pressure: (level: typeof pressure) => { pressure = level; },
            available: (bytes: number) => { available = bytes; }, missingVitals: (value: boolean) => { missingVitals = value; },
            get stops() { return stops; }, get nativeReads() { return nativeReads; }, get factsReads() { return factsReads; } };
    }

    it('keeps automatic auxiliary and memory observations on minutes while Overview is live, including failed-reader retries', async () => {
        const native = createGuardLeftBehindFixture();
        native.advance(20000); vi.setSystemTime(native.now());
        const readPolicy = () => MachineGuardPolicyV1Schema.parse({
            memoryGuard: { enabled: true, sustainMs: 60000 }, leftBehind: { mode: 'automatic', graceMs: 600000 },
        });
        let plans = 0;
        const f = await setup(undefined, true, true, { readPolicy, ownership: native.ownership,
            createPolicyWork(activity) {
                const actuator = createLeftBehindActuator({ activity, nowMs: native.now,
                    readPolicy: () => readPolicy().leftBehind, confirmed: native.tracker.confirmed,
                    readRestoration: () => null,
                    executeAction: async () => { throw new Error('No cleanup is due during this observation'); },
                });
                const listeners = new Set<() => void>();
                return { enabled: policy => policy.leftBehind.mode !== 'off',
                    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
                    async readPlan() {
                        plans++; await native.observe();
                        const plan = actuator.plan();
                        return { nextAt: plan.nextAt };
                    },
                    refreshOnTick() { actuator.invalidateFailures(); for (const listener of listeners) listener(); },
                    stop() { listeners.clear(); },
                };
            },
        });
        f.pressure('calm');
        const release = f.sampler.demandOverview(); cleanup.push(release);
        await vi.advanceTimersByTimeAsync(0); await f.drain();
        const initialPlans = plans;
        const initialFactsReads = f.factsReads;
        await vi.advanceTimersByTimeAsync(58000); await f.drain();
        expect(f.sampler.latest()?.intervalMs).toBe(2000);
        expect(plans).toBe(initialPlans);
        expect(f.factsReads).toBe(initialFactsReads);
        const ownerPlans = plans;
        native.advance(60000); await vi.advanceTimersByTimeAsync(2000); await f.drain();
        expect(plans).toBeGreaterThan(ownerPlans);
        f.missingVitals(true);
        await vi.advanceTimersByTimeAsync(2000); await f.drain();
        const failedPlans = plans;
        await vi.advanceTimersByTimeAsync(56000); await f.drain();
        expect(plans).toBe(failedPlans);
        native.advance(60000); await vi.advanceTimersByTimeAsync(2000); await f.drain();
        expect(plans).toBeGreaterThan(failedPlans);
        expect(f.stops).toBe(0);
    });

    it('warns after a fresh composed read even when the inventory publishes its settled observation during that read', async () => {
        const f = await setup(undefined, true, false, undefined, true);
        f.duringFactsRead(async () => {
            await new Promise<void>(resolve => setTimeout(resolve, 60000));
            // startDaemon reads the live inventory again after draft/resume admission.
            // An owner invalidation must be reconciled by that final observation.
            f.working(false);
            await f.inventory.read();
        });
        const current = f.policy.read();
        if (current.status !== 'ready') throw Error('Policy unavailable');
        await f.policy.set({expectedRevision:current.revision,patch:{guard:{idleSessions:{enabled:true,afterMs:360000,warnBeforeMs:300000}}}});
        await vi.advanceTimersByTimeAsync(240000); await f.drain();
        expect(f.guard.runtime.readSessionWarning('workspace-session')).toEqual({stopAt:epoch+360000});
        f.duringFactsRead(async () => {});
        f.working(true);
        await f.drain();
        expect(f.guard.runtime.readSessionWarning('workspace-session')).toBeUndefined();
        expect(f.stops).toBe(0);
    });

    it('warns from the real idle policy despite unrelated metadata revisions during fresh fact reads', async () => {
        const f = await setup(undefined, true, false, undefined, true);
        f.duringFactsRead(async () => {
            // Authenticated metadata and Session transport are separate network boundaries.
            await new Promise<void>(resolve => setTimeout(resolve, 60000));
            await f.metadataOnlyChange();
        });
        const current = f.policy.read();
        if (current.status !== 'ready') throw new Error('Policy fixture unavailable');
        expect(await f.policy.set({ expectedRevision: current.revision,
            patch: { guard: { idleSessions: { enabled: true, afterMs: 360000, warnBeforeMs: 300000 } } } }))
            .toMatchObject({ status: 'applied' });
        await f.drain();
        await vi.advanceTimersByTimeAsync(180000); await f.drain();
        expect(f.notices).toContainEqual({ kind: 'stopping', rule: 'idle_sessions', stopAt: epoch + 360000 });
        expect(f.guard.runtime.readSessionWarning('workspace-session')).toEqual({ stopAt: epoch + 360000 });
        f.duringFactsRead(async () => {});
        const observed = MachineGuardWatchResultV1Schema.parse({ changed: true, since: 1,
            view: await f.guard.watch.readView(requester) });
        if (!observed.changed) throw new Error('Guard view fixture unavailable');
        expect(observed.view.idle)
            .toContainEqual(expect.objectContaining({ sessionRef: 'workspace-session', status: 'stops_at', stopAt: epoch + 360000 }));
        await vi.advanceTimersByTimeAsync(180000); await f.drain();
        expect(f.stops).toBe(1);
        expect((await f.guard.activityLog.list({ range: 'today' })).entries)
            .toContainEqual(expect.objectContaining({ kind: 'stopped_session', rule: 'idle_sessions', outcome: 'done' }));
        const afterStop = f.policy.read();
        if (afterStop.status !== 'ready') throw new Error('Policy fixture unavailable');
        expect(await f.policy.set({ expectedRevision: afterStop.revision, patch: { guard: { idleSessions: { enabled: false } } } }))
            .toMatchObject({ status: 'applied' });
        await f.drain();
        expect(f.guard.runtime.readSessionWarning('workspace-session')).toBeUndefined();
    });

    it('runs confirmed left-behind policy work through the same factory Activity and summary, with no Off reads or subscriptions', async () => {
        const native = createGuardLeftBehindFixture();
        await native.observe(); native.advance(60000); await native.observe();
        vi.setSystemTime(native.now());
        const taggedRow = native.rows.get(300)!;
        const rootStart = native.roots[0]?.start;
        if (!rootStart) throw new Error('Left-behind fixture requires its captured process birth');
        let mode: 'off' | 'automatic' = 'off';
        const readPolicy = () => MachineGuardPolicyV1Schema.parse({ leftBehind: { mode, graceMs: 60000 } });
        const signals: number[] = [];
        const nativeActions = createProcessActionExecutor({ ownership: native.ownership, leftBehind: native.tracker,
            allProcessesVisible: () => false, requesterForOwner: () => guardLeftBehindAttribution, selfPid: process.pid, platform: 'darwin',
            systemBoundary: { platform: 'darwin', censusDependencies: native.censusDependencies,
                kill(pid) { signals.push(pid); native.rows.delete(pid); }, wait: async () => undefined } });
        const cleanupResults: Awaited<ReturnType<typeof nativeActions.cleanUp>>[] = [];
        // The Machine RPC is a network boundary; the real Action and native cleanup owners run beneath it.
        const actions = createActionExecutor({ machineProcessesAction: async request => {
            if (request.actionId !== 'machines.processes.leftBehind.cleanUp') throw new Error('Unexpected fixture Action');
            const result = await nativeActions.cleanUp(MachineProcessesCleanUpInputV1Schema.parse(request.input),
                { accountId: 'owner', isCustodian: true }, { signal: request.signal ?? request.context.signal });
            cleanupResults.push(result); return result;
        } } as ActionExecutorDeps);
        const listeners = new Set<() => void>();
        let reads = 0;
        let stopped = 0;
        let planSignal: AbortSignal | undefined;
        const f = await setup(undefined, true, false, { readPolicy, ownership: native.ownership,
            createPolicyWork(activity) {
                const actuator = createLeftBehindActuator({ activity, nowMs: native.now,
                    readPolicy: () => readPolicy().leftBehind, confirmed: () => native.tracker.confirmed(),
                    readRestoration: () => ({ attribution: guardLeftBehindAttribution, wayBack: [{ label: 'start_again',
                        actionId: 'machines.processes.startAgain', input: { machineId: 'machine', ref: processRef(200, rootStart) } }] }),
                    executeAction: request => actions.execute('machines.processes.leftBehind.cleanUp',
                        { serverId: 'home', machineId: 'machine', refs: [...request.refs] },
                        { surface: 'rpc', authority: 'account_automation', actionCaller: { kind: 'host' },
                            runtimeAccountId: 'owner', serverId: 'home', defaultSessionId: request.sessionId, signal: request.signal }),
                });
                return { enabled: policy => policy.leftBehind.mode !== 'off',
                    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
                    async readPlan({ signal }) {
                        reads++; planSignal = signal;
                        await native.observe();
                        const plan = actuator.plan();
                        return { nextAt: plan.nextAt, ...(plan.due[0] ? { run: async () => { await actuator.execute(plan.due[0]!, signal); } } : {}) };
                    },
                    refreshOnTick() { for (const listener of [...listeners]) listener(); },
                    stop() { expect(planSignal?.aborted).toBe(true); stopped++; },
                };
            },
        });
        native.advance(60000); await vi.advanceTimersByTimeAsync(60000); await f.drain();
        expect(reads).toBe(0); expect(listeners.size).toBe(0); expect(f.nativeReads).toBe(0);
        mode = 'automatic'; await f.policy.reload(); await f.drain();
        const activity = await f.guard.activityLog.list({ range: 'today' });
        expect(cleanupResults).toMatchObject([{ ended: [{ freedBytes: 3000 }, { freedBytes: 3010 }], skipped: [] }]);
        expect(activity.entries).toMatchObject([{ kind: 'stopped_left_behind', rule: 'left_behind',
            subject: { kind: 'processes', count: 2 }, freedBytes: 6010, outcome: 'done' }]);
        expect(signals).toEqual([300, 301]);
        expect(f.summary.getSummary()?.lastAutomaticAction?.facts).toEqual({ rule: 'left_behind', freedBytes: 6010, count: 2 });
        expect(listeners.size).toBe(1);
        // A newly orphaned child is discovered by this same minute hook, confirmed by
        // the existing tracker, and cleaned only after its separate grace expires.
        native.rows.set(302, { ...taggedRow, pid: 302, pgid: 302,
            start: { startTimeMs: 302, native: 'darwin-proc:302:0:302' }, memory: { kind: 'rss', bytes: 3020 } });
        native.advance(60000); await vi.advanceTimersByTimeAsync(60000); await f.drain();
        native.advance(60000); await vi.advanceTimersByTimeAsync(60000); await f.drain();
        expect(signals).toEqual([300, 301]);
        native.advance(60000); await vi.advanceTimersByTimeAsync(60000); await f.drain();
        expect(signals).toEqual([300, 301, 302]);
        expect((await f.guard.activityLog.list({ range: 'today' })).entries).toHaveLength(2);
        expect(f.summary.getSummary()?.lastAutomaticAction?.facts).toEqual({ rule: 'left_behind', freedBytes: 3020, count: 1 });
        mode = 'off'; await f.policy.reload(); await f.drain();
        const offReads = reads; f.guard.refreshOnTick(); await f.drain();
        expect(reads).toBe(offReads); expect(listeners.size).toBe(0);
        await f.guard.stop(); await f.guard.stop(); expect(stopped).toBe(1);
        f.guard.refreshOnTick(); await f.drain(); expect(reads).toBe(offReads);
    });

    it('withdraws the actual auxiliary terminal warning when policy becomes Off without a new census', async () => {
        const native = await createIdleTerminalPolicyFixture(cleanup);
        vi.setSystemTime(native.nowMs());
        native.foreground(102); native.enable();
        const terminal = await native.terminals.ensure({ terminalKey: 'silent-command', cwd: '/project', custody: {
            ...target, requesterAccountId: requester.accountId, kind: 'machine', rootPath: '/project',
        } });
        expect(terminal.ok).toBe(true);
        let enabled = true;
        const readPolicy = () => ({ ...native.readPolicy(), idleTerminals: { ...native.readPolicy().idleTerminals, enabled } });
        const f = await setup(undefined, true, false, { ownership: native.ownership, readPolicy,
            createPolicyWork: activityLog => createIdleTerminalPolicy({ getTerminals: () => native.terminals,
                ownership: native.ownership, activityLog, readPolicy, readTarget: () => target, nowMs: native.nowMs,
                notifyWarning: native.notifyWarning,
            }),
        });
        native.now(90000); await vi.advanceTimersByTimeAsync(90000); await f.drain();
        expect(native.terminals.list()[0]).toMatchObject({ terminalGuardStateV1: { kind: 'stopping' } });
        expect(native.deliveries).toHaveLength(1);
        expect((await f.guard.watch.readView(requester)).idleTerminals)
            .toMatchObject([{ terminalKey: 'silent-command', status: 'stops_at' }]);
        const reads = native.nativeReads();
        enabled = false; await f.policy.reload(); await f.drain();
        expect(native.terminals.list()[0]).not.toHaveProperty('terminalGuardStateV1');
        expect(native.nativeReads()).toBe(reads);
        await vi.advanceTimersByTimeAsync(60000); await f.drain();
        expect(native.nativeReads()).toBe(reads);
        expect(native.terminals.list()).toHaveLength(1);
        expect((await f.guard.activityLog.list({ range: 'today' })).entries).toEqual([]);
    });

    it('starts the real episode, publishes its state, records only a measured effect, then releases parked observers on stop', async () => {
        const f = await setup();
        await vi.advanceTimersByTimeAsync(60000); await f.drain();
        expect(f.stops).toBe(1);
        expect(f.summary.getSummary()?.guard?.episode).toMatchObject({ state: 'verifying', step: 1 });
        expect(f.summary.getSummary()).not.toHaveProperty('lastAutomaticAction');
        f.gone(); await f.drain(); f.available(180);
        await vi.advanceTimersByTimeAsync(60000); await f.drain();
        const activity = await f.guard.activityLog.list({ range: 'today' });
        expect(MachineGuardActivityListV1Schema.parse(activity)).toEqual(activity);
        const persisted = await readFile(join(directory, 'machine-guard', 'activity-2026-10-10.jsonl'), 'utf8');
        const stored: unknown[] = persisted.trim().split('\n').map(line => JSON.parse(line));
        expect(stored.map(row => MachineGuardActivityEntryV1Schema.parse(row))).toEqual(expect.arrayContaining(activity.entries));
        const effect = activity.entries.find(entry => entry.kind === 'closed_browser');
        expect(effect).toMatchObject({ outcome: 'done', freedBytes: 80 });
        expect(f.summary.getSummary()?.lastAutomaticAction).toMatchObject({ entryId: effect?.id, facts: { freedBytes: 80 } });
        expect(f.summary.getSummary()?.guard?.episode).toMatchObject({ state: 'out_of_steps' });
        expect(f.summary.getSummary()?.guard).not.toHaveProperty('episodeId');
        expect(new Set(f.intervals)).toEqual(new Set([60000]));
        const first = await f.guard.watch.watch({ machineId: target.machineId }, requester);
        expect(MachineGuardWatchResultV1Schema.parse(first)).toEqual(first);
        expect(MachinePublishedResourceSummaryV1Schema.parse(f.summary.getSummary())).toEqual(f.summary.getSummary());
        expect(first.changed).toBe(true); if (!first.changed) throw new Error('Initial Guard view missing');
        const parked = f.guard.watch.watch({ machineId: target.machineId, since: first.since }, requester);
        await f.drain();
        const invalidated = vi.fn(); f.guard.subscribeInvalidation(invalidated);
        await f.guard.stop(); expect(await parked).toEqual({ changed: false });
        const readsAfterStop = f.nativeReads; const invalidationsAfterStop = invalidated.mock.calls.length;
        f.guard.refreshOnTick(); await f.policy.reload();
        await vi.advanceTimersByTimeAsync(60000); await f.drain();
        expect(f.nativeReads).toBe(readsAfterStop);
        expect(invalidated).toHaveBeenCalledTimes(invalidationsAfterStop);
        expect(f.intervals.at(-1)).toBe(60000);
    });

    it('shares sustained Project eligibility with preview and preserves the captured original Start again after native Stop', async () => {
        const f = await setup(undefined, true, true);
        const busy = await f.guard.watch.readView(requester);
        expect(busy.ladder.excluded).toMatchObject([{ kind: 'service', reason: 'working' }]);
        f.working(false); f.connections(1); await f.drain();
        expect((await f.guard.watch.readView(requester)).ladder.excluded).toMatchObject([{ kind: 'service', reason: 'visitors' }]);
        f.connections(0); await f.drain();
        const initialQuiet = await f.guard.watch.readView(requester);
        expect(initialQuiet.ladder.excluded).toMatchObject([{ kind: 'service', reason: 'connections_unknown' }]);
        await vi.advanceTimersByTimeAsync(60000); await f.drain();
        expect(f.stops).toBe(0);
        const firstQuiet = await f.guard.watch.readView(requester);
        expect(firstQuiet.ladder.steps[1]?.candidates).toMatchObject([{ kind: 'service',
            wayBack: [{ label: 'start_again', actionId: 'localServices.launcher.start', input: f.originalStart }] }]);
        f.pressure('critical');
        await vi.advanceTimersByTimeAsync(60000); await f.drain();
        expect(f.stops).toBeGreaterThan(0);
        expect(f.summary.getSummary()?.guard?.episode).toMatchObject({ state: 'verifying', step: 2 });
        expect(f.summary.getSummary()).not.toHaveProperty('lastAutomaticAction');
        f.available(180); await vi.advanceTimersByTimeAsync(60000); await f.drain();
        const effect = (await f.guard.activityLog.list({ range: 'today' })).entries.find(entry => entry.kind === 'stopped_service');
        expect(effect).toMatchObject({ outcome: 'done', freedBytes: 80, attribution: { ...target, accountId: requester.accountId },
            wayBack: [{ label: 'start_again', actionId: 'localServices.launcher.start', input: f.originalStart }] });
        expect(f.summary.getSummary()?.lastAutomaticAction).toMatchObject({ entryId: effect?.id, facts: { freedBytes: 80 } });
        const view = await f.guard.watch.readView(requester);
        expect(view.recentActivity.find(entry => entry.id === effect?.id)?.wayBack?.[0]?.input).toEqual(f.originalStart);
        expect(new Set(f.intervals)).toEqual(new Set([60000]));
    });

    it('retires the composed owner when its Home lifetime is cancelled', async () => {
        const lifetime = new AbortController(); const f = await setup(lifetime.signal);
        lifetime.abort(); await f.guard.stop();
        await vi.advanceTimersByTimeAsync(60000); await f.drain();
        expect(f.stops).toBe(0);
        expect(await f.guard.watch.watch({ machineId: target.machineId }, requester)).toEqual({ changed: false });
    });

    it('finishes Guard shutdown while an uncancellable shared Session activity reply remains live', async () => {
        const f = await setup(undefined, true, true);
        const transport = f.holdActivity();
        await transport.started;
        let publisherFinished = false;
        const publisher = f.inventory.read().then(value => { publisherFinished = true; return value; });
        let stopped = false;
        let stopping: Promise<void> | undefined;
        try {
            const readsBeforeGuardRefresh = f.nativeReads;
            f.guard.refreshOnTick();
            await f.drain();
            // Vitals ticks update Guard state and auxiliary policy work, but facts
            // have their own inventory invalidation and deadline owners. A tick
            // must not restart the full native process census.
            expect(f.nativeReads).toBe(readsBeforeGuardRefresh);
            stopping = f.guard.stop().then(() => { stopped = true; });
            await f.drain();
            expect(stopped).toBe(true);
            expect(publisherFinished).toBe(false);
            expect(f.stops).toBe(0);
            expect((await f.guard.activityLog.list({ range: 'today' })).entries).toEqual([]);
        } finally {
            transport.finish();
            await (stopping ?? f.guard.stop());
            expect((await publisher).coverage).toBe('complete');
        }
    });

    it('uses canonical disabled defaults while retained policy is invalid, with no census or faster sampling', async () => {
        const f = await setup(undefined, false);
        expect(f.policy.read().status).toBe('invalid');
        await vi.advanceTimersByTimeAsync(120000); await f.drain();
        expect(f.stops).toBe(0); expect(f.nativeReads).toBe(0);
        expect(f.summary.getSummary()?.guard).not.toHaveProperty('episode');
        expect(new Set(f.intervals)).toEqual(new Set([60000]));
    });
});
