import { basename } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import axios from 'axios';
import { expect, vi } from 'vitest';
import * as hostExec from '../../../../apps/cli/src/plugins/runtime/invocation/services/exec';
import * as hostRuntime from '../../../../apps/cli/src/deployments/targets/ownServer/ownServerDeploymentHostRuntime';
import type { OwnServerDeploymentRuntimeAcquisition } from '../../../../apps/cli/src/deployments/targets/ownServer/ownServerDeploymentTarget';
import type { OwnServerDockerInvocation } from '../../../../apps/cli/src/deployments/targets/ownServer/ownServerDeployment.testkit';

type RequestCost = { phase: string; method: string; route: string; admissions: number; status: number | null };
type CostServer = {
    setCostPhase(phase: string): void;
    readRequestCosts(): RequestCost[];
};

/** Pass-through observers preserve real HTTP/auth/runtime and the existing Docker OS testkit. */
export function createDeploymentFlowCostObserver() {
    let server: CostServer | undefined;
    let phase = 'fixture';
    let nativeCommands: (() => Promise<readonly OwnServerDockerInvocation[]>) | undefined;
    let capturedCommands: readonly OwnServerDockerInvocation[] | undefined;
    const daemonReads: Record<string, Record<string, number>> = {};
    const guards: Array<{ phase: string; kind: string; calls: number; http: number; permissionRechecks: number; daemonReads: number }> = [];
    const guardScope = new AsyncLocalStorage<(typeof guards)[number]>();
    const acquisitions: Array<{ phase: string; kind: string; role: string; secrets: number; http: number }> = [];
    const acquisitionScope = new AsyncLocalStorage<(typeof acquisitions)[number]>();
    const producers: Record<string, number> = {};
    const identityObservations: Array<{ phase: string; turn: number; producer: string; caller: string; context: string[] }> = [];
    let identityTurn = 0;
    let identityTurnOpen = false;
    const workflowOperations: Array<{ phase: string; operation: string; runId?: string; invocationId?: string }> = [];
    const localRootExecutions: Array<{ phase: string; actionId: string; leafActionId?: string }> = [];
    const previousStackLimit = Error.stackTraceLimit;
    Error.stackTraceLimit = 40;
    const recordProducer = (kind: string) => {
        const stack = new Error().stack?.split('\n').slice(2).filter(line => !line.includes('node_modules') && !line.includes('node:') && !line.includes('workflow.deploymentFlowCosts.testkit')).join('\n') ?? '';
        const key = `${phase} ${kind}\n${stack}`;
        producers[key] = (producers[key] ?? 0) + 1;
        return stack;
    };
    const previousAdapter = axios.defaults.adapter;
    const transport = axios.getAdapter(previousAdapter);
    axios.defaults.adapter = async request => {
        const path = new URL(request.url!, request.baseURL).pathname;
        recordProducer(`HTTP ${request.method} ${path}`);
        if (path === '/v3/automations/runs/workflow-storage') {
            // Count only operation names and resource ids, never content or credentials.
            const body: unknown = typeof request.data === 'string' ? JSON.parse(request.data) : request.data;
            if (body && typeof body === 'object' && 'operation' in body && typeof body.operation === 'string') {
                workflowOperations.push({ phase, operation: body.operation,
                    ...('runId' in body && typeof body.runId === 'string' ? { runId: body.runId } : {}),
                    ...('invocationId' in body && typeof body.invocationId === 'string' ? { invocationId: body.invocationId } : {}) });
            }
        }
        const acquisition = acquisitionScope.getStore();
        if (acquisition) {
            acquisition.http++;
            if (path.endsWith('/secret-launch-admission')) acquisition.secrets++;
        }
        const guard = guardScope.getStore();
        if (guard) {
            guard.http++;
            if (/\/(?:admission|execution-authorization)\/verify$/u.test(path)) guard.permissionRechecks++;
        }
        return await transport(request);
    };
    const observeGuard = (kind: string, run: () => Promise<void>) => {
        const byPhase = new Map<string, (typeof guards)[number]>();
        return async () => {
            let counter = byPhase.get(phase);
            if (!counter) {
                counter = { phase, kind, calls: 0, http: 0, permissionRechecks: 0, daemonReads: 0 };
                byPhase.set(phase, counter);
                guards.push(counter);
            }
            counter.calls++;
            await guardScope.run(counter, run);
        };
    };
    const observeRuntime = <T extends Pick<OwnServerDeploymentRuntimeAcquisition, 'assertCurrent' | 'assertSourceCurrent'>>(acquired: T) => ({
        ...acquired,
        assertCurrent: observeGuard('assertCurrent', acquired.assertCurrent),
        assertSourceCurrent: observeGuard('assertSourceCurrent', acquired.assertSourceCurrent),
    });
    const authorizeLaunch = hostExec.authorizePluginExecLaunchForHost;
    const launchObserver = vi.spyOn(hostExec, 'authorizePluginExecLaunchForHost').mockImplementation(async (...args) => {
        const launch = await authorizeLaunch(...args);
        if (!/^docker(?:\.exe)?$/u.test(basename(launch.command)) || !launch.recheckInputs) return launch;
        return { ...launch, recheckInputs: observeGuard('recheckInputs', launch.recheckInputs) };
    });
    const createRuntime = hostRuntime.createOwnServerDeploymentRuntimeForHost;
    const runtimeObserver = vi.spyOn(hostRuntime, 'createOwnServerDeploymentRuntimeForHost').mockImplementation(host => {
        const runtime = createRuntime(host);
        return { ...runtime,
            ...(runtime.acquireCandidate ? { acquireCandidate: async (...args: Parameters<NonNullable<typeof runtime.acquireCandidate>>) => {
                const cost = { phase, kind: 'candidate', role: 'review', secrets: 0, http: 0 };
                acquisitions.push(cost);
                return observeRuntime(await acquisitionScope.run(cost, () => runtime.acquireCandidate!(...args)));
            } } : {}),
            ...(runtime.acquireRetention ? { acquireRetention: async (...args: Parameters<NonNullable<typeof runtime.acquireRetention>>) => {
                const retained = await runtime.acquireRetention!(...args);
                return { ...retained, assertCurrent: observeGuard('retention.assertCurrent', retained.assertCurrent) };
            } } : {}),
            acquire: async (request, snapshot) => {
                const cost = { phase, kind: request.materialization.kind, role: request.executionRole ?? 'runtime', secrets: 0, http: 0 };
                acquisitions.push(cost);
                return observeRuntime(await acquisitionScope.run(cost, () => runtime.acquire(request, snapshot)));
        } };
    });
    const measured = () => server?.readRequestCosts().filter(cost => !['fixture', 'neighbor'].includes(cost.phase)) ?? [];
    return {
        attach(value: CostServer) { server = value; value.setCostPhase(phase); },
        setPhase(value: string) { phase = value; server?.setCostPhase(value); },
        recordLocalRootExecution(actionId: string, leafActionId?: string) {
            localRootExecutions.push({ phase, actionId, ...(leafActionId ? { leafActionId } : {}) });
        },
        recordDaemonRead(kind: string) {
            const stack = recordProducer(`daemon ${kind}`);
            if (kind === 'identity') {
                const frames = stack.split('\n').filter(line => line.includes('/apps/cli/src/'));
                // A queued microtask separates synchronous observations from
                // awaited continuations without runtime-specific async ids.
                if (!identityTurnOpen) {
                    identityTurn++;
                    identityTurnOpen = true;
                    queueMicrotask(() => { identityTurnOpen = false; });
                }
                identityObservations.push({ phase, turn: identityTurn, producer: frames[0] ?? '', caller: frames[1] ?? '', context: frames.slice(2, 8) });
            }
            const guard = guardScope.getStore();
            if (guard) guard.daemonReads++;
            const reads = daemonReads[phase] ??= {};
            reads[kind] = (reads[kind] ?? 0) + 1;
        },
        observeNativeCommands(read: () => Promise<readonly OwnServerDockerInvocation[]>) { nativeCommands = read; },
        async captureNativeCommands() { capturedCommands = await nativeCommands?.(); },
        assertCandidatePublication() {
            const publications = measured().filter(cost => cost.phase === 'native-review' && cost.method === 'POST'
                && cost.route === '/v1/artifacts');
            expect(publications.filter(cost => cost.status !== null && cost.status >= 200 && cost.status < 300).length,
                'one accepted candidate publication per native review').toBe(1);
        },
        assertPublishPreparationReads() {
            const reads = Object.entries(producers).filter(([key]) => key.startsWith('review HTTP get ')
                && (key.includes('Object.prepareDeploymentAction') || key.includes('Object.deploymentChild')));
            const count = (path: RegExp) => reads.filter(([key]) => path.test(key.split('\n')[0]))
                .reduce((sum, [, total]) => sum + total, 0);
            // Publish host and native receiver each admit references at their
            // own boundary: one Environment and its candidate/definition/link.
            expect({ artifacts: count(/\/v1\/artifacts\/[^/]+$/u),
                environments: count(/\/v1\/deployments\/environments\/[^/]+$/u) },
            'one input read set per Publish preparation receiver, without repeated loads across review awaits')
                .toEqual({ artifacts: 6, environments: 2 });
        },
        assertShape() {
            const requests = measured();
            const contractReads = localRootExecutions.filter(item => item.phase === 'approve' && item.actionId === 'action.spec.get');
            expect(contractReads.length, 'one local root admission per distinct Workflow leaf contract')
                .toBe(new Set(contractReads.map(item => item.leafActionId)).size);
            expect(requests.length, 'composed journey must reach actual Home HTTP').toBeGreaterThan(0);
            // Features is public; unmatched 404s have no route or authentication handler.
            // Both still contribute to total HTTP and failed-request observations.
            const protectedRequests = requests.filter(cost => cost.route !== '/v1/features' && cost.route !== 'unmatched');
            expect(protectedRequests.map(cost => cost.admissions),
                'one authentication admission per protected HTTP request').toEqual(protectedRequests.map(() => 1));
            expect(guards.filter(guard => guard.calls > 0).length, 'actual native runtime must be observed').toBeGreaterThan(0);
            expect(acquisitions.map(cost => cost.secrets), 'one secret acquisition per native phase, independent of its commands')
                .toEqual(acquisitions.map(() => 1));
            const historyEnvironmentReads = Object.entries(producers).filter(([key]) => !/^(fixture|neighbor) /u.test(key)
                && /HTTP get \/v1\/deployments\/environments\/[^/\n]+\n/u.test(key) && key.includes('readBuildHistory'))
                .reduce((sum, [, count]) => sum + count, 0);
            expect(historyEnvironmentReads, 'receipt history consumes the phase Environment already loaded by its native owner').toBe(0);
            const transitionReads = Object.entries(producers).filter(([key]) => !/^(fixture|neighbor) /u.test(key)
                && /HTTP get \/v1\/artifacts\/[^/]+\n/u.test(key) && key.includes('writeTransition'))
                .reduce((sum, [, count]) => sum + count, 0);
            const transitions = requests.filter(cost => cost.method === 'POST' && cost.route.endsWith('/transitions'));
            expect(transitionReads, 'one Artifact load per receipt content transition, reusing its admitted update resource')
                .toBe(transitions.length);
            const noticeReads = Object.entries(producers).filter(([key]) => !/^(fixture|neighbor) /u.test(key)
                && key.includes('deploymentSettlementNotices.ts'));
            const noticeWrites = noticeReads.filter(([key]) => /HTTP post \/v1\/artifacts(?:\/[^/]+)?\n/u.test(key))
                .reduce((sum, [, count]) => sum + count, 0);
            for (const resource of ['environments', 'receipts']) {
                const reads = noticeReads.filter(([key]) => new RegExp(`HTTP get /v1/deployments/${resource}/[^/\\n]+\\n`, 'u').test(key))
                    .reduce((sum, [, count]) => sum + count, 0);
                expect.soft(reads, `one fresh ${resource} read per notice write; no read for an arrival without a notice change`)
                    .toBe(noticeWrites);
            }
            expect(guards.reduce((sum, guard) => sum + guard.daemonReads, 0),
                'zero daemon-file rereads per admitted native step').toBe(0);
            expect(guards.reduce((sum, guard) => sum + guard.http, 0),
                'zero Home reads from admitted native-step guards').toBe(0);
            expect(guards.reduce((sum, guard) => sum + guard.permissionRechecks, 0),
                'zero remote permission rechecks inside admitted native steps').toBe(0);
        },
        async result(flow: string) {
            const requests = measured();
            const byPhase: Record<string, { http: number; admissions: number; secrets: number; environments: number; receipts: number }> = {};
            const routes: Record<string, number> = {};
            for (const cost of requests) {
                const counts = byPhase[cost.phase] ??= { http: 0, admissions: 0, secrets: 0, environments: 0, receipts: 0 };
                counts.http++;
                counts.admissions += cost.admissions;
                if (cost.route.endsWith('/secret-launch-admission')) counts.secrets++;
                if (cost.method === 'GET' && /\/environments\/:[^/]+$/u.test(cost.route)) counts.environments++;
                if (cost.method === 'GET' && /\/deployments(?:\/:[^/]+)?$/u.test(cost.route)) counts.receipts++;
                const key = `${cost.phase} ${cost.method} ${cost.route}`;
                routes[key] = (routes[key] ?? 0) + 1;
            }
            const commands = capturedCommands;
            return { flow, scope: 'real HTTP/SQLite/runtime with existing Docker OS testkit; fixture and neighbor excluded; secrets counts grant-admission requests with empty bindings',
                http: requests.length, admissions: requests.reduce((sum, cost) => sum + cost.admissions, 0),
                producers: Object.fromEntries(Object.entries(producers).filter(([key]) => !/^(fixture|neighbor) /u.test(key))),
                identityObservations: identityObservations.filter(item => !['fixture', 'neighbor'].includes(item.phase)),
                workflowOperations: workflowOperations.filter(item => !['fixture', 'neighbor'].includes(item.phase)),
                localRootExecutions: localRootExecutions.filter(item => !['fixture', 'neighbor'].includes(item.phase)),
                byPhase, routes, failedRequests: requests.filter(cost => cost.status !== null && cost.status >= 400),
                daemonReads: Object.fromEntries(Object.entries(daemonReads).filter(([key]) => !['fixture', 'neighbor'].includes(key))),
                guards: guards.filter(cost => !['fixture', 'neighbor'].includes(cost.phase)),
                acquisitions: acquisitions.filter(cost => !['fixture', 'neighbor'].includes(cost.phase)),
                nativeCommands: commands?.length ?? null,
                activations: commands?.filter(command => command.args.includes('up')).length ?? null };
        },
        dispose() { Error.stackTraceLimit = previousStackLimit; axios.defaults.adapter = previousAdapter; runtimeObserver.mockRestore(); launchObserver.mockRestore(); },
    };
}

export type DeploymentFlowCostObserver = ReturnType<typeof createDeploymentFlowCostObserver>;
