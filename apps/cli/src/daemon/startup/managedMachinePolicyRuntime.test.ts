import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { ManagedPolicyCensusInputV1Schema } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { createDaemonManagedMachinePolicyRuntime, readManagedMachinePolicyCensus } from './managedMachinePolicyRuntime';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { createDaemonManagedMachineActionAdapter } from './managedMachineActionAdapter';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { executeManagedMachinePolicyAction } from './managedMachinePolicyAction';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionOperationListV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { UpdateBodySchema } from '@happier-dev/protocol';
import type { Update } from '@/api/types';
import { ManagedWakeTargetV1Schema } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { ApiMachineClient } from '@/api/apiMachine';

afterEach(() => vi.restoreAllMocks());
describe('daemon managed policy census transport', () => {
    it('executes the Home wake candidate despite a retained running native observation without private guest reads', async () => {
        const signing = nacl.sign.keyPair();
        const controller = { machineId: 'controller', installationId: 'installation' };
        const machine = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'home', custodianAccountId: 'owner',
            controller, enrolledMachineId: 'requester-guest', enrollmentAccountId: 'requester',
            launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            allocation: 'bound', resource: { contributionRef: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true,
            observation: { availability: 'present', power: 'running', storage: 'retained', observedAt: 1 } });
        const target = ManagedWakeTargetV1Schema.parse({ homeId: 'home', managedId: machine.id,
            enrolledMachineId: machine.enrolledMachineId, expectedIntentRevision: 0, controller, reason: 'admitted-work',
            origin: { kind: 'session-input', session: { homeId: 'home', sessionId: 'session' }, pendingRequestId: 'pending', requestedAt: 1 } });
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { machines: [machine], targets: [target] } });
        const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'owner' });
        // Runtime-registry acquisition is the installed-process boundary. The
        // scheduler, operation lifecycle and policy Action stay real.
        const adapter = createDaemonManagedMachineActionAdapter({ credentials: { token: 'token', encryption: null },
            machineId: 'controller', serverId: 'home', serverBaseUrl: 'https://policy.example', installationIdentity: null,
            acquireRuntimeRegistryLease: async () => { throw new Error('No native runtime is installed'); },
            observeActionExecution: request => operations.observeExecution(request),
            executeManagedPolicyAction: (current, context, runApproved) => executeManagedMachinePolicyAction({ machine: current,
                context, runApproved, serverId: 'home', createExecutor: overrides => createActionExecutor({ ...createUnavailableActionTransportDeps(), ...overrides }) }),
        });
        const runtime = createDaemonManagedMachinePolicyRuntime({
            readCensus: signal => readManagedMachinePolicyCensus({ homeId: 'home', controller,
                custodianAccountId: 'owner', privateKey: signing.secretKey, token: 'token', serverUrl: 'https://policy.example', signal }),
            loadMachine: async () => { throw new Error('Requester-private guest content is unavailable to the controller'); },
            executePolicy: adapter.executePolicy,
        });
        try {
            await runtime.notifyChanged();
            await vi.waitFor(async () => expect(ActionOperationListV1ResponseSchema.parse(await operations.handlers.listV2({})).items)
                .toMatchObject([{ state: 'failed', error: { errorCode: 'admission_unavailable' },
                    domainRef: { kind: 'managedMachine', id: machine.id } }]));
        } finally { await runtime.stop(); }
    });
    it('accepts an Account-owned row and target without assigning the observing daemon as controller', async () => {
        const signing = nacl.sign.keyPair();
        const machine = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'home', custodianAccountId: 'owner',
            enrolledMachineId: 'guest',
            launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            allocation: 'bound', resource: { contributionRef: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
            creationState: 'active', desired: 'stop', desiredWhen: 'now', intentRevision: 0,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true });
        const target = ManagedWakeTargetV1Schema.parse({ homeId: 'home', managedId: machine.id,
            enrolledMachineId: 'guest', expectedIntentRevision: 0, reason: 'admitted-work',
            origin: { kind: 'session-input', session: { homeId: 'home', sessionId: 'session' }, pendingRequestId: 'pending', requestedAt: 1 } });
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { machines: [machine], targets: [target] } });
        const census = await readManagedMachinePolicyCensus({ homeId: 'home',
            controller: { machineId: 'own-daemon', installationId: 'installation' }, custodianAccountId: 'owner',
            privateKey: signing.secretKey, token: 'token', serverUrl: 'https://policy.example' });
        expect(census.machines).toEqual([machine]);
        expect(census.targets).toEqual([target]);
        expect(census.machines[0]).not.toHaveProperty('controller');
    });

    it('schedules from classified Machine invalidations rather than raw Account, Pending or Automation traffic', async () => {
        let censuses = 0;
        const signing = nacl.sign.keyPair();
        vi.spyOn(axios, 'post').mockImplementation(async () => {
            censuses += 1;
            return { status: 200, data: { machines: [], targets: [] } };
        });
        const apiMachine = new ApiMachineClient('token', { id: 'controller', encryptionMode: 'plain',
            metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
        const transport = apiMachine as unknown as {
            dispatchUpdate(update: Update): boolean;
            notifyManagedMachinePolicyInvalidated(): Promise<void>;
        };
        const runtime = createDaemonManagedMachinePolicyRuntime({ apiMachine,
            readCensus: signal => readManagedMachinePolicyCensus({ homeId: 'home',
                controller: { machineId: 'controller', installationId: 'installation' }, custodianAccountId: 'owner',
                privateKey: signing.secretKey, token: 'token', serverUrl: 'https://policy.example', signal }),
            executePolicy: async () => { throw new Error('No policy work'); } });
        const drain = () => new Promise<void>(resolve => setImmediate(resolve));
        try {
            for (const raw of [
                { t: 'account-change' },
                { t: 'pending-changed', sid: 'unrelated', pendingCount: 0, pendingVersion: 1 },
                { t: 'automation-run-updated', runId: 'unrelated', automationId: null, state: 'queued', scheduledAt: 1, updatedAt: 1 },
            ]) transport.dispatchUpdate({ id: 'wake', seq: 1, createdAt: 1, body: UpdateBodySchema.parse(raw) });
            await drain();
            expect(censuses).toBe(0);
            await transport.notifyManagedMachinePolicyInvalidated();
            await drain();
            expect(censuses).toBe(1);
        } finally {
            await runtime.stop();
            await apiMachine.shutdown();
        }
        await transport.notifyManagedMachinePolicyInvalidated();
        await drain();
        expect(censuses).toBe(1);
    });
    it.each([
        ['session-input', false], ['workflow-assignment', false], ['context-delivery', false],
        ['session-input', true], ['workflow-assignment', true],
    ] as const)(
        'retires held accepted work after its own %s origin changes (retargeted: %s), ignoring other origins', async (kind, retargeted) => {
        const signing = nacl.sign.keyPair();
        const controller = { machineId: 'controller', installationId: 'installation' };
        const machine = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'home', custodianAccountId: 'owner',
            controller, enrolledMachineId: 'guest',
            launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            allocation: 'bound', resource: { contributionRef: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true });
        const target = ManagedWakeTargetV1Schema.parse({ homeId: 'home', managedId: machine.id,
            enrolledMachineId: 'guest', expectedIntentRevision: 0, controller, reason: 'admitted-work',
            origin: kind === 'session-input' ? { kind, session: { homeId: 'home', sessionId: 'session' }, pendingRequestId: 'pending', requestedAt: 1 }
                : kind === 'workflow-assignment' ? { kind, runId: 'run', revision: 1, assignment: { machineId: 'guest' } }
                : { kind, session: { homeId: 'home', sessionId: 'session' }, delivery: { runId: 'run', revision: 1 } } });
        let targets = [target];
        let reads = 0;
        vi.spyOn(axios, 'post').mockImplementation(async () => {
            reads += 1;
            return { status: 200, data: { machines: [machine], targets } };
        });
        const apiMachine = new ApiMachineClient('token', { id: 'controller', encryptionMode: 'plain',
            metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
        const transport = apiMachine as unknown as { dispatchUpdate(update: Update): boolean };
        let held: AbortSignal | undefined;
        const runtime = createDaemonManagedMachinePolicyRuntime({ apiMachine,
            readCensus: signal => readManagedMachinePolicyCensus({ homeId: 'home', controller,
                custodianAccountId: 'owner', privateKey: signing.secretKey, token: 'token', serverUrl: 'https://policy.example', signal }),
            // The native operation's outstanding lifetime is the boundary observed by the scheduler.
            executePolicy: async input => {
                const signal = input.signal;
                if (!signal) throw new Error('A policy driver must receive its lifetime');
                held = signal;
                await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
                return { ok: true, result: {} };
            } });
        const changed = async (id: string) => {
            const body = UpdateBodySchema.parse({ ...(kind === 'session-input'
                ? { t: 'pending-changed', sid: id, pendingCount: 0, pendingVersion: 2 }
                : { t: 'automation-run-updated', runId: id, automationId: null, state: 'cancelled', scheduledAt: 1, updatedAt: 2 }),
                ...(retargeted ? { managedWakeTargetV1: { ...target, controller: { ...target.controller, machineId: 'replacement-controller' } } } : {}),
            });
            transport.dispatchUpdate({ id: 'origin-change', seq: 1, createdAt: 1, body });
            await new Promise<void>(resolve => setImmediate(resolve));
        };
        try {
            runtime.notifyChanged();
            await vi.waitFor(() => expect(held).toBeDefined());
            targets = [];
            await changed('unrelated');
            expect(reads).toBe(1);
            expect(held?.aborted).toBe(false);
            await changed(kind === 'session-input' ? 'session' : 'run');
            expect(reads).toBe(2);
            expect(held?.aborted).toBe(true);
        } finally { await runtime.stop(); await apiMachine.shutdown(); }
    });
    it.each([
        { desired: 'delete', submitted: true, enrolled: false, deadline: false },
        { desired: 'delete', submitted: false, enrolled: true, deadline: false },
        { desired: 'start', submitted: true, enrolled: false, deadline: false },
        { desired: 'delete', submitted: false, enrolled: true, deadline: true },
        { desired: 'stop', submitted: true, enrolled: false, deadline: false },
        { desired: 'stop', submitted: true, enrolled: true, deadline: false },
        { desired: 'stop', submitted: true, enrolled: true, deadline: true },
        { desired: 'suspend', submitted: true, enrolled: true, deadline: false },
    ] as const)('creates no retention operations during repeated invalidations for a manual Delete or Stop: %j', async fixture => {
        const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8));
        const controller = { machineId: 'controller', installationId: 'installation' };
        const machine = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'home', custodianAccountId: 'owner', controller,
            launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            allocation: 'bound', resource: { contributionRef: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
            creationState: 'active', desired: fixture.desired, desiredWhen: 'now', intentRevision: 1,
            retention: fixture.deadline ? { kind: 'deadline', at: 0, effect: 'stop', interrupts: true }
                : { kind: 'unused', afterMs: 3_600_000, effect: 'stop' }, wakeOnAcceptedMessage: false,
            ...(fixture.enrolled ? { enrolledMachineId: 'guest' } : {}),
            ...(fixture.submitted ? { submittedNativeEffect: { intentRevision: 1, requestId: 'manual-control',
                intent: fixture.desired === 'start' ? 'delete' : fixture.desired, controller } } : {}),
        });
        let censusReads = 0;
        vi.spyOn(axios, 'post').mockImplementation(async () => {
            censusReads += 1;
            return { status: 200, data: { machines: [machine], targets: [] } };
        });
        const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'owner' });
        const adapter = createDaemonManagedMachineActionAdapter({ credentials: { token: 'owner-token', encryption: null },
            machineId: 'controller', serverId: 'home', serverBaseUrl: 'https://home.example', installationIdentity: null,
            acquireRuntimeRegistryLease: async () => { throw new Error('No native runtime is installed'); },
            observeActionExecution: request => operations.observeExecution(request),
            executeManagedPolicyAction: (current, context, runApproved) => executeManagedMachinePolicyAction({ machine: current,
                context, runApproved, serverId: 'home', createExecutor: overrides => createActionExecutor({ ...createUnavailableActionTransportDeps(), ...overrides }) }),
        });
        const runtime = createDaemonManagedMachinePolicyRuntime({
            loadMachine: async id => ({ id, encryptionMode: 'plain', active: true, metadata: null, metadataVersion: 0,
                daemonState: { status: 'running' }, daemonStateVersion: 1 }),
            readCensus: signal => readManagedMachinePolicyCensus({ homeId: 'home', controller,
                custodianAccountId: 'owner', privateKey: key.secretKey, token: 'owner-token', serverUrl: 'https://home.example', signal }),
            executePolicy: adapter.executePolicy,
        });
        try {
            for (let index = 0; index < 32; index += 1) {
                runtime.notifyChanged();
                await new Promise<void>(resolve => setImmediate(resolve));
            }
            expect(censusReads).toBe(32);
            expect(ActionOperationListV1ResponseSchema.parse(await operations.handlers.listV2({})).items).toHaveLength(0);
        } finally { await runtime.stop(); }
    });
    it('defers unused retention until guest readiness without deferring a reviewed deadline or canceled creation cleanup', async () => {
        const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8));
        const controller = { machineId: 'controller', installationId: 'installation' };
        let machine = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'home', custodianAccountId: 'owner',
            controller,
            launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            allocation: 'bound', resource: { contributionRef: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
            retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' }, wakeOnAcceptedMessage: true });
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { machines: [machine], targets: [] } });
        const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'owner' });
        // The actual operation/adapter path remains real. This installation has
        // no native custody, so any scheduled attempt settles as unavailable.
        const adapter = createDaemonManagedMachineActionAdapter({ credentials: { token: 'owner-token', encryption: null },
            machineId: 'controller', serverId: 'home', serverBaseUrl: 'https://home.example', installationIdentity: null,
            acquireRuntimeRegistryLease: async () => { throw new Error('No native runtime is installed'); },
            observeActionExecution: request => operations.observeExecution(request),
            executeManagedPolicyAction: (current, context, runApproved) => executeManagedMachinePolicyAction({ machine: current,
                context, runApproved, serverId: 'home', createExecutor: overrides => createActionExecutor({ ...createUnavailableActionTransportDeps(), ...overrides }) }),
        });
        const list = async () => ActionOperationListV1ResponseSchema.parse(await operations.handlers.listV2({})).items;
        const runtime = createDaemonManagedMachinePolicyRuntime({
            loadMachine: async id => ({ id, encryptionMode: 'plain', active: true, metadata: null, metadataVersion: 0,
                daemonState: { status: 'running' }, daemonStateVersion: 1 }),
            readCensus: signal => readManagedMachinePolicyCensus({ homeId: 'home', controller,
                custodianAccountId: 'owner', privateKey: key.secretKey, token: 'owner-token', serverUrl: 'https://home.example', signal }),
            executePolicy: adapter.executePolicy,
        });
        const notify = async () => {
            runtime.notifyChanged();
            // Drain the in-process census/operation microtasks, including a
            // possible failure, before reading the real operation RPC surface.
            await new Promise<void>(resolve => setImmediate(resolve));
        };
        try {
            await notify();
            expect(await list()).toEqual([]);
            machine = ManagedMachineV1Schema.parse({ ...machine, enrolledMachineId: 'guest' });
            vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { machines: [machine], targets: [] } });
            await notify();
            await vi.waitFor(async () => expect(await list()).toMatchObject([{ state: 'failed', error: { errorCode: 'admission_unavailable' },
                domainRef: { kind: 'managedMachine', id: machine.id } }]));
            machine = ManagedMachineV1Schema.parse({ ...machine, enrolledMachineId: undefined,
                retention: { kind: 'deadline', at: Date.now() + 3_600_000, effect: 'stop', interrupts: true } });
            vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { machines: [machine], targets: [] } });
            await notify();
            await vi.waitFor(async () => expect(await list()).toHaveLength(2));
            machine = ManagedMachineV1Schema.parse({ ...machine, creationState: 'canceled', desired: 'delete' });
            vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { machines: [machine], targets: [] } });
            await notify();
            await vi.waitFor(async () => expect(await list()).toHaveLength(3));
            machine = ManagedMachineV1Schema.parse({ ...machine, creationState: 'active', desired: 'stop',
                retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' },
                submittedNativeEffect: { intentRevision: 0, requestId: 'submitted-stop', intent: 'stop', controller: machine.controller } });
            vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { machines: [machine], targets: [],
                retentionContinuations: [{ managedId: machine.id, requestId: 'submitted-stop' }] } });
            await notify();
            await vi.waitFor(async () => expect(await list()).toHaveLength(4));
            machine = ManagedMachineV1Schema.parse({ ...machine, desired: 'suspend',
                submittedNativeEffect: { intentRevision: 0, requestId: 'submitted-suspend', intent: 'suspend', controller: machine.controller } });
            vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { machines: [machine], targets: [],
                retentionContinuations: [{ managedId: machine.id, requestId: 'submitted-suspend' }] } });
            await notify();
            await vi.waitFor(async () => expect(await list()).toHaveLength(5));
        } finally {
            await runtime.stop();
        }
    });
    it('schedules controller-free retention only on its enrolled guest without a remote private Machine read', async () => {
        const machine = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'home', custodianAccountId: 'owner',
            enrolledMachineId: 'guest',
            launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            allocation: 'bound', resource: { contributionRef: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
            retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' }, wakeOnAcceptedMessage: false });
        const operations = createHostActionOperationRuntime({ machineId: 'guest', resolveAccountId: async () => 'owner' });
        const adapter = createDaemonManagedMachineActionAdapter({ credentials: { token: 'owner-token', encryption: null },
            machineId: 'guest', serverId: 'home', serverBaseUrl: 'https://home.example', installationIdentity: null,
            acquireRuntimeRegistryLease: async () => { throw new Error('No native runtime is installed'); },
            observeActionExecution: request => operations.observeExecution(request),
            executeManagedPolicyAction: (current, context, runApproved) => executeManagedMachinePolicyAction({ machine: current,
                context, runApproved, serverId: 'home', createExecutor: overrides => createActionExecutor({ ...createUnavailableActionTransportDeps(), ...overrides }) }),
        });
        let remoteReads = 0;
        const runtime = createDaemonManagedMachinePolicyRuntime({ executorMachineId: 'guest',
            readCensus: async () => ({ machines: [machine], targets: [] }),
            loadMachine: async () => { remoteReads += 1; return null; }, executePolicy: adapter.executePolicy });
        try {
            runtime.notifyChanged();
            await vi.waitFor(async () => expect(ActionOperationListV1ResponseSchema.parse(await operations.handlers.listV2({})).items)
                .toMatchObject([{ domainRef: { kind: 'managedMachine', id: machine.id } }]));
            expect(remoteReads).toBe(0);
        } finally { await runtime.stop(); }
        const otherRuntime = createDaemonManagedMachinePolicyRuntime({ executorMachineId: 'another-daemon',
            readCensus: async () => ({ machines: [machine], targets: [] }),
            loadMachine: async () => { remoteReads += 1; return null; }, executePolicy: adapter.executePolicy });
        try {
            await otherRuntime.notifyChanged();
            expect(remoteReads).toBe(0);
            expect(ActionOperationListV1ResponseSchema.parse(await operations.handlers.listV2({})).items).toHaveLength(1);
        } finally { await otherRuntime.stop(); }
    });
    it('retires an incumbent unused-retention operation when the resource observation satisfies its stop effect', async () => {
        let machine = ManagedMachineV1Schema.parse({
            id: 'managed', homeId: 'home', custodianAccountId: 'owner',
            controller: { machineId: 'controller', installationId: 'installation' }, enrolledMachineId: 'guest',
            launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            allocation: 'bound', resource: { contributionRef: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
            retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' }, wakeOnAcceptedMessage: false,
            observation: { observedAt: 1, availability: 'present', power: 'running' },
        });
        let held: AbortSignal | undefined;
        const runtime = createDaemonManagedMachinePolicyRuntime({
            loadMachine: async id => ({ id, encryptionMode: 'plain', active: true, metadata: null, metadataVersion: 0,
                daemonState: { status: 'running' }, daemonStateVersion: 1 }),
            readCensus: async () => ({ machines: [machine], targets: [] }),
            executePolicy: async input => {
                held = input.signal;
                await new Promise<void>(resolve => input.signal?.addEventListener('abort', () => resolve(), { once: true }));
                return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
            },
        });
        try {
            runtime.notifyChanged();
            await vi.waitFor(() => expect(held).toBeDefined());
            machine = ManagedMachineV1Schema.parse({ ...machine,
                observation: { observedAt: 2, availability: 'present', power: 'suspended' } });
            runtime.notifyChanged();
            await vi.waitFor(() => expect(held?.aborted).toBe(true));
        } finally {
            await runtime.stop();
        }
    });
    it('does not read policy work while controller prerequisites are absent and resumes when they become available', async () => {
        const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8));
        const requests: unknown[] = [];
        vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
            requests.push(body);
            return { status: 200, data: { machines: [], targets: [] } };
        });
        let available = false;
        const unavailable: unknown[] = [];
        const options = {
            isAvailable: () => available,
            readCensus: (signal: AbortSignal) => readManagedMachinePolicyCensus({
                homeId: 'home', controller: { machineId: 'controller', installationId: 'installation' },
                custodianAccountId: 'owner', privateKey: key.secretKey, token: 'owner-token', serverUrl: 'https://home.example', signal,
            }),
            executePolicy: async () => { throw new Error('No policy was admitted'); },
            onUnavailable: (error: unknown) => unavailable.push(error),
        };
        const runtime = createDaemonManagedMachinePolicyRuntime(options);
        try {
            runtime.notifyChanged();
            await Promise.resolve();
            runtime.notifyChanged();
            await Promise.resolve();
            expect(requests).toEqual([]);
            expect(unavailable).toEqual([]);
            available = true;
            runtime.notifyChanged();
            await vi.waitFor(() => expect(requests).toHaveLength(1));
        } finally {
            await runtime.stop();
        }
    });
    it('reads only the current signed controller census and rejects unavailable authority rather than inventing empty work', async () => {
        const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8));
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            expect(url).toBe('https://home.example/v1/machines/managed/controller/policies');
            const input = ManagedPolicyCensusInputV1Schema.parse(body);
            expect(verifyMachineInstallationProof({ proof: input.proof, publicKey: key.publicKey,
                payload: { version: 1, machineId: input.controller.machineId,
                    installationId: input.controller.installationId, accountId: 'owner',
                    managedPolicyCensus: { homeId: input.homeId } } })).toBe(true);
            return { status: 200, data: { machines: [], targets: [] } };
        });
        const input = { homeId: 'home', controller: { machineId: 'controller', installationId: 'installation' },
            custodianAccountId: 'owner', privateKey: key.secretKey, token: 'owner-token', serverUrl: 'https://home.example' };
        expect(await readManagedMachinePolicyCensus(input)).toEqual({ machines: [], targets: [] });
        vi.mocked(axios.post).mockResolvedValue({ status: 403, data: { machines: [], targets: [] } });
        await expect(readManagedMachinePolicyCensus(input)).rejects.toMatchObject({ code: 'admission_unavailable' });
    });
});
