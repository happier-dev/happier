import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate, setTimeout as pause } from 'node:timers/promises';
import nacl from 'tweetnacl';
import { DEFAULT_AUTOMATION_V3_MAX_ACTIVE_RUNS_PER_MACHINE } from '@happier-dev/protocol';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { MANAGED_ACTIVITY_READ_RPC_METHOD, MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD,
    ManagedActivityBridgeResultV1Schema } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { reloadConfiguration } from '@/configuration';
import { createDeferred } from '@/testkit/async/deferred';
import { registerManagedActivityRpcHandlers } from '@/api/machine/rpcHandlers.managedActivity';
import { requestSessionInputLiveWork } from '@/agent/runtime/session/input/sessionProviderInputAdmissionRpc';
import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
import { createManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { fixture } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { prepareManagedRetentionPolicy } from '@/machines/managed/managedIntentReconciler';
import { createActionOperationStore } from '../actionOperations/actionOperationStore';
import { createDaemonAdmissionDrain } from '../lifecycle/admissionDrain';
import { createLiveWorkProducerGroup, createManagedActivityInventory } from '../lifecycle/managedActivity';
import { createSessionLiveWorkProducer } from '../lifecycle/sessionLiveWorkProducer';
import { startAutomationWorker } from './automationWorker';

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); reloadConfiguration(); });

async function waitForClaim(check: () => boolean) {
    // Let real HTTP finish without advancing its fake Axios timeout alongside
    // the selected retention clock. This deadline belongs only to the test.
    const deadline = performance.now() + 2_000;
    while (!check()) {
        if (performance.now() >= deadline) throw new Error('Expected claim did not reach the HTTP boundary');
        await pause(1);
    }
}

async function harness(withSession = false) {
    const directory = await mkdtemp(join(tmpdir(), 'qb64-idle-'));
    const claims: ServerResponse[] = [];
    let holdClaims = false;
    let failClaims = false;
    let holdSessions = false;
    const sessionReads: ServerResponse[] = [];
    const sessionReply = (response: ServerResponse) => response.end(JSON.stringify({
        session: 'settled', input: 'settled', agents: 'settled', attention: 'settled', settledAt: 1,
    }));
    const server = createServer((request, response) => {
        response.setHeader('Content-Type', 'application/json');
        if (request.url?.startsWith('/v3/automations/worker/assignments')) {
            response.end(JSON.stringify({ assignments: [], settings: {
                maxActiveRunsPerMachine: DEFAULT_AUTOMATION_V3_MAX_ACTIVE_RUNS_PER_MACHINE,
            } }));
        } else if (request.url?.startsWith('/v3/automations/worker/run-lifecycle')) {
            response.end(JSON.stringify({ sources: [] }));
        } else if (request.url === '/v3/automations/runs/claim') {
            claims.push(response);
            if (failClaims) { response.statusCode = 503; response.end(JSON.stringify({ error: 'claim_unavailable' })); }
            else if (!holdClaims) response.end(JSON.stringify({ run: null, automation: null, accountCurrentness: null }));
        } else if (request.url === '/session/activity') {
            sessionReads.push(response);
            if (!holdSessions) sessionReply(response);
        } else { response.statusCode = 404; response.end('{}'); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP boundary unavailable');
    const origin = `http://127.0.0.1:${address.port}`;
    vi.stubEnv('HAPPIER_HOME_DIR', directory);
    vi.stubEnv('HAPPIER_SERVER_URL', origin);
    vi.stubEnv('HAPPIER_WEBAPP_URL', origin);
    reloadConfiguration();
    // The clock is the only mocked boundary. Assignment/claim traffic uses real
    // HTTP, temporary local configuration and the production strict readers.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(1_790_000_000_000);
    const since = Date.now();
    const drain = createDaemonAdmissionDrain();
    const worker = startAutomationWorker({ token: 'disposable-harness',
        credentials: { token: 'disposable-harness', encryption: null }, machineId: 'guest', admissionDrain: drain });
    const automation = createLiveWorkProducerGroup(() => [worker.liveWorkProducer]);
    const tracked = { pid: 1, startedBy: 'daemon' as const, happySessionId: 'retained-session' };
    const sessions = createSessionLiveWorkProducer({ readSessions: () => withSession ? [tracked] : [],
        readActivity: () => requestSessionInputLiveWork({ callRpc: async () =>
            (await fetch(`${origin}/session/activity`)).json() }) });
    const operations = createActionOperationStore();
    const inventory = createManagedActivityInventory({ producers: [sessions, automation,
        { read: operations.readLiveWork, subscribe: operations.subscribe }] });
    const publications: unknown[] = [];
    const unsubscribe = inventory.subscribe(decision => { publications.push(decision); });
    await worker.refreshAssignments();
    return { since, origin, directory, worker, inventory, drain, claims, publications, operations, sessionReads,
        holdClaims() { holdClaims = true; },
        failClaims(value: boolean) { failClaims = value; },
        holdSessions() { holdSessions = true; },
        releaseSessions() { holdSessions = false; for (const response of sessionReads) if (!response.writableEnded) sessionReply(response); },
        releaseClaims() {
            holdClaims = false;
            for (const response of claims) if (!response.writableEnded) response.end(JSON.stringify({ run: null, automation: null, accountCurrentness: null }));
            for (const response of sessionReads) if (!response.writableEnded) sessionReply(response);
        },
        async close() {
            worker.stop(); unsubscribe(); inventory.dispose(); automation.dispose();
            for (const response of claims) if (!response.writableEnded) response.end(JSON.stringify({ run: null, automation: null, accountCurrentness: null }));
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            await rm(directory, { recursive: true, force: true });
        },
    };
}

describe('Automation observation and managed unused retention', () => {
    it('keeps failed claim coverage unknown until a successful observation starts a new idle interval', async () => {
        const owner = await harness();
        try {
            expect(await owner.inventory.readDecision()).toEqual({ kind: 'idle', since: owner.since });
            owner.failClaims(true);
            await vi.advanceTimersByTimeAsync(60_000);
            await waitForClaim(() => owner.claims.length > 0);
            expect(await owner.inventory.readDecision()).toEqual({ kind: 'unknown', reasons: ['coverage_unknown'] });
            owner.failClaims(false);
            const previous = owner.claims.length;
            // First retry uses the worker's existing one-second backoff;
            // advancing only the next timer can consume HTTP cleanup instead.
            await vi.advanceTimersByTimeAsync(1_000);
            await waitForClaim(() => owner.claims.length > previous);
            expect(await owner.inventory.readDecision()).toEqual({ kind: 'idle', since: Date.now() });
        } finally { await owner.close(); }
    });

    it('invalidates a shared pre-claim observation before confirming a drain, without erasing the idle anchor', async () => {
        const owner = await harness(true);
        try {
            expect(await owner.inventory.readDecision()).toEqual({ kind: 'idle', since: owner.since });
            owner.holdSessions();
            const priorRequests = owner.sessionReads.length;
            const oldObservation = owner.inventory.readDecision();
            await waitForClaim(() => owner.sessionReads.length > priorRequests);
            owner.holdClaims();
            await vi.advanceTimersByTimeAsync(60_000);
            await waitForClaim(() => owner.claims.length === 1);
            owner.drain.beginUnusedStopDrain();
            let confirmed = false;
            const confirmation = owner.inventory.readDecision().then(result => { confirmed = true; return result; });
            owner.releaseSessions();
            expect(await oldObservation).toMatchObject({ kind: 'unknown' });
            await setImmediate();
            expect(confirmed).toBe(false);
            owner.releaseClaims();
            expect(await confirmation).toEqual({ kind: 'idle', since: owner.since });
        } finally { owner.releaseSessions(); owner.releaseClaims(); await owner.close(); }
    });

    it('preserves idle across empty periodic claims and admits Stop at the original one-hour boundary', async () => {
        const owner = await harness();
        const cancellation = new AbortController();
        const handlers = new Map<string, RpcHandler<unknown, unknown>>();
        const key = nacl.sign.keyPair();
        const controller = { machineId: 'controller', installationId: 'controller-installation' };
        const machine = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'srv_managed_idle', custodianAccountId: 'owner',
            controller,
            launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
            allocation: 'bound', creationState: 'active',
            resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
            enrolledMachineId: 'guest', desired: 'start', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' }, wakeOnAcceptedMessage: true });
        const target = { homeId: machine.homeId, managedId: machine.id, expectedRevision: machine.intentRevision,
            controller };
        const context: RpcHandlerContext = { signal: cancellation.signal,
            machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'guest',
                installationId: 'guest-installation', role: 'manage', encryptionMode: 'plain' },
            verifyMachineAdmissionCurrent: async () => true };
        registerManagedActivityRpcHandlers({ activity: owner.inventory, admissionDrain: owner.drain,
            rpcHandlerManager: { registerHandler<TRequest, TResponse>(method: string, handler: RpcHandler<TRequest, TResponse>) {
                handlers.set(method, (raw, ingress) => handler(raw as TRequest, ingress));
            } }, validateCurrentTarget: async candidate => candidate.managedId === machine.id
                && candidate.expectedRevision === machine.intentRevision,
            commitIdleEvidence: (managedTarget, idle, ingress) => {
                if (!owner.drain.isQuiescing() || !ingress.machineAdmission) return null;
                const method = `guest:${MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD}`;
                const decision = { ...idle, confirmedAt: Date.now() };
                return { context: ingress.machineAdmission, method, managedTarget, decision,
                    proof: signMachineInstallationProof({ privateKey: key.secretKey, payload: { version: 1,
                        accountId: 'owner', machineId: 'guest', installationId: 'guest-installation',
                        rpcAdmission: { context: ingress.machineAdmission, method, managedTarget, managedIdleDecision: decision } } }) };
            } });
        const call = async (method: string, request: unknown) => ManagedActivityBridgeResultV1Schema.parse(
            await handlers.get(method)!(request, context));
        const bridge = {
            read: async () => call(MANAGED_ACTIVITY_READ_RPC_METHOD, target),
            confirmIdle: async () => call(MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD, { ...target, action: 'begin' }),
            reopen: async () => call(MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD, { ...target, action: 'resume' }),
            waitForChange: async (signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
                const cleanup = () => { unsubscribe(); signal?.removeEventListener('abort', abort); };
                const abort = () => { cleanup(); reject(signal?.reason); };
                const unsubscribe = owner.inventory.subscribe(() => { cleanup(); resolve(); });
                signal?.addEventListener('abort', abort, { once: true });
                if (signal?.aborted) abort();
            }),
        };
        const unavailable = async (): Promise<never> => { throw new Error('Unexpected credential boundary'); };
        const authority = createManagedProviderOperationAuthority({ materializationBaseDir: owner.directory,
            purposeBindingOwner: createConnectedAccountPurposeBindingOwner({
                store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable, subscribe: () => ({ dispose() {} }) },
                selectTarget: unavailable, resolveTarget: unavailable, materializeAccount: unavailable,
                projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable,
            }), requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 1,
            createRedactionLease: () => ({ add() {}, close() {} }) });
        const initialized = createDeferred();
        let ready = false;
        let preparation: ReturnType<typeof prepareManagedRetentionPolicy> | undefined;
        try {
            expect(await bridge.read()).toMatchObject({ kind: 'idle', since: owner.since });
            preparation = prepareManagedRetentionPolicy({ machine, purpose: { kind: 'retention' },
                options: { requestId: 'unused-stop', signal: cancellation.signal },
                input: { token: 'disposable-harness', credentials: { token: 'disposable-harness', encryption: null },
                    serverUrl: owner.origin, homeId: machine.homeId, controller,
                    runtimeRegistry: fixture().runtimeRegistry, managedProviderOperationAuthority: authority,
                    homeTarget: resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: machine.homeId,
                        canonicalServerUrl: owner.origin, revision: 1, endpoints: [{ kind: 'https', url: owner.origin }] }, authority: 'current_connection' }),
                    managedGuestActivity: { ...bridge, read: async () => { const result = await bridge.read(); initialized.resolve(); return result; } },
                    readPolicyCurrent: async () => machine,
                } }).then(result => { ready = true; return result; });
            await initialized.promise;
            for (let index = 0; index < 59; index++) {
                const previous = owner.claims.length;
                await vi.advanceTimersByTimeAsync(60_000);
                await waitForClaim(() => owner.claims.length > previous);
                expect(await bridge.read()).toMatchObject({ kind: 'idle', since: owner.since });
                expect(ready).toBe(false);
            }
            await vi.advanceTimersByTimeAsync(owner.since + 3_599_999 - Date.now());
            expect(await bridge.read()).toMatchObject({ kind: 'idle', since: owner.since });
            expect(ready).toBe(false);
            await vi.advanceTimersByTimeAsync(owner.since + 3_600_000 - Date.now());
            const result = await preparation;
            expect(owner.drain.isQuiescing()).toBe(false);
            expect(result).toMatchObject({ purpose: { kind: 'retention',
                evidence: { decision: { kind: 'idle', since: owner.since, confirmedAt: owner.since + 3_600_000 } } } });
            expect(owner.publications.length).toBeGreaterThan(1);
            for (const publication of owner.publications) expect(publication).toEqual({ kind: 'idle', since: owner.since });
        } finally {
            cancellation.abort();
            await preparation?.catch(() => {});
            await owner.close();
        }
    });

    it('does not let a held activity probe prove idle, and preserves the anchor when the probe finds no work', async () => {
        const owner = await harness();
        try {
            expect(await owner.inventory.readDecision()).toEqual({ kind: 'idle', since: owner.since });
            owner.holdClaims();
            await vi.advanceTimersByTimeAsync(60_000);
            await waitForClaim(() => owner.claims.length === 1);
            owner.drain.beginUnusedStopDrain();
            let observed = false;
            const confirmation = owner.inventory.readDecision().then(result => { observed = true; return result; });
            await setImmediate();
            expect(observed).toBe(false);
            owner.releaseClaims();
            expect(await confirmation).toEqual({ kind: 'idle', since: owner.since });
            owner.operations.create({ operationId: 'accepted-work', actionId: 'projects.script.run', title: 'Work',
                scope: { accountId: 'owner', machineId: 'guest' }, cancellation: 'supported', inputIdentity: '{}' });
            expect(await owner.inventory.readDecision()).toEqual({ kind: 'busy', reasons: ['finite'] });
            owner.operations.updateObservation('accepted-work', { kind: 'outcome_uncertain', code: 'native_outcome_uncertain' });
            expect(await owner.inventory.readDecision()).toEqual({ kind: 'unknown', reasons: ['finite'] });
            vi.setSystemTime(Date.now() + 1);
            owner.operations.succeed('accepted-work', {});
            expect(await owner.inventory.readDecision()).toEqual({ kind: 'idle', since: Date.now() });
        } finally { await owner.close(); }
    });
});
