import { expect, it } from 'vitest';
import { projectMachineAgent } from '@/agents/machineAgents/machineAgentModel';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { buildSessionReadinessViewModel, readSessionPersonalCredentialReadiness } from './sessionReadinessViewModel';
import { QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { PluginConnectedAccountAuthenticationV2Schema } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import { SessionReadinessV1Schema } from '@happier-dev/protocol/sessions/control/sessionReadinessV1';
import { MachineAgentInventoryItemSchema } from '@happier-dev/protocol/capabilities';

const facts = MachineAgentInventoryItemSchema.parse({
    agentId: 'acme-agent', title: 'Acme', installed: true, version: null, latestVersion: null,
    update: { supported: false, command: null },
    signIn: { status: 'signedOut', loginSupport: 'login_terminal' },
    platform: { supported: true }, install: { available: false, mode: 'manual', sizeBytes: null, guideUrl: null }, dependencies: [],
});
const agent = projectMachineAgent({ agentId: facts.agentId, title: facts.title, facts,
    checking: false, stale: false, connectedServices: [], job: null });
const input: Parameters<typeof buildSessionReadinessViewModel>[0] = {
    configured: true, machine: { scope: { serverId: 'home', accountId: 'alice' }, selectedMachineId: 'machine-1',
        machine: { id: 'machine-1', active: true }, requireExactSpawnReadiness: true, rpcAvailable: true, keyAvailable: true },
    agent, selection: { credentialBindings: null }, inventory: { status: 'ready', lastCheckedAt: 10 },
    invocation: { v: 1, level: 'owner', sources: [], capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
    mayRepairAgent: true,
};

it('uses current selected Agent facts and prepares the real native sign-in Action only for an entitled repairer', () => {
    const vm = buildSessionReadinessViewModel(input);
    expect(vm.readiness).toMatchObject({ configured: true, status: 'unavailable', cause: 'agent' });
    expect(vm.repair).toEqual({ actionId: 'machines.agents.signIn.start',
        input: { machineId: 'machine-1', agentId: 'acme-agent', method: 'native' } });
    expect(buildSessionReadinessViewModel({ ...input, mayRepairAgent: false }).repair).toBeNull();
    expect(buildSessionReadinessViewModel({ ...input, selection: null }).readiness.status).toBe('unknown');
});

it('keeps unknown inventory distinct from unsupported and offline, without clearing authorized results', () => {
    const ready = projectMachineAgent({ agentId: facts.agentId, title: facts.title,
        facts: { ...facts, signIn: { ...facts.signIn, status: 'signedIn' } },
        checking: false, stale: false, connectedServices: [], job: null });
    expect(buildSessionReadinessViewModel({ ...input, agent: ready }).readiness.status).toBe('ready');
    expect(buildSessionReadinessViewModel({ ...input, agent: ready, inventory: { status: 'error', lastCheckedAt: 10 } }).readiness.status).toBe('unknown');
    expect(buildSessionReadinessViewModel({ ...input, agent: ready, machine: { ...input.machine, machineReachable: false } }).readiness)
        .toMatchObject({ status: 'unavailable', cause: 'machine', machine: { status: 'offline' } });
    const unsupported = projectMachineAgent({ agentId: facts.agentId, title: facts.title,
        facts: { ...facts, platform: { supported: false, reason: 'arch' } },
        checking: false, stale: false, connectedServices: [], job: null });
    expect(buildSessionReadinessViewModel({ ...input, agent: unsupported }).readiness)
        .toMatchObject({ status: 'unavailable', cause: 'agent', machine: { status: 'ready' }, agent: { state: 'unsupported' } });
});

it('preserves inventory lifecycle readiness and suppresses duplicate native sign-in repair while its terminal is open', () => {
    const job = { jobId: 'install', intent: 'install', startedAtMs: 1, steps: [], logLine: null, outcome: null } as const;
    for (const outcome of [null, { kind: 'failed', code: 'download_failed', stepId: null, message: null }] as const) {
        const installing = projectMachineAgent({ agentId: facts.agentId, title: facts.title, facts,
            checking: false, stale: false, connectedServices: [], job: { ...job, outcome } });
        expect(buildSessionReadinessViewModel({ ...input, agent: installing }))
            .toMatchObject({ readiness: { status: 'unavailable', agent: { state: 'notInstalled' } }, repair: null });
    }
    for (const phase of ['opening', 'waiting'] as const) {
        expect(buildSessionReadinessViewModel({ ...input, signIn: {
            phase, terminalKey: 'sign-in', authUrl: null, startedAtMs: 1, failure: null,
        } })).toMatchObject({ readiness: { status: 'unavailable', agent: { state: 'needsSignIn' } }, repair: null });
    }
    const stale = projectMachineAgent({ agentId: facts.agentId, title: facts.title, facts,
        checking: false, stale: true, connectedServices: [], job: null });
    expect(buildSessionReadinessViewModel({ ...input, agent: stale }))
        .toMatchObject({ readiness: { status: 'unknown', agent: { state: 'unknown' } }, repair: null });
    const checking = projectMachineAgent({ agentId: facts.agentId, title: facts.title, facts: null,
        checking: true, stale: false, connectedServices: [], job: null });
    expect(buildSessionReadinessViewModel({ ...input, agent: checking, inventory: { status: 'loading', lastCheckedAt: null } }))
        .toMatchObject({ readiness: { status: 'unknown', agent: { state: 'checking' } }, repair: null });
});

it('does not offer Move from a ready destination alone', () => {
    const idle = { phase: 'idle', errorCode: null, carrierPhase: 'unknown', carrierErrorCode: null } as const;
    const handoff = { targetMachineSelected: true, targetMachineAttemptable: true, sourceMachineAttemptable: false,
        relationshipRequested: false, relationshipResolved: true, workspaceActionResolved: true,
        workspaceEngineRequired: false, machineCarrierRequired: false, sourcePathAllowed: true, targetPathAllowed: true,
        sourceEngineReadiness: idle, targetEngineReadiness: idle };
    expect(buildSessionReadinessViewModel({ ...input, handoff }).handoff)
        .toEqual({ canStart: false, reason: 'source_machine_unavailable' });
    expect(buildSessionReadinessViewModel({ ...input, handoff: { ...handoff, sourceMachineAttemptable: true } }).handoff)
        .toEqual({ canStart: true });
    expect(buildSessionReadinessViewModel(input).handoff).toBeNull();
});

it('reuses purpose/profile usability for an expired selected connection and its exact entitled reconnect', () => {
    const service = { pluginId: 'acme.external', localId: 'account' };
    const account = { service, accountId: 'work' };
    const purpose = { consumer: { pluginId: 'acme.external', localId: 'helper' }, purpose: 'outside-write' };
    const profile = QualifiedConnectedAccountProfileV4Schema.parse({ ref: account, status: 'connected',
        revisionSemantics: 'revisioned', credentialRevision: `csr_${'a'.repeat(22)}`, authenticationModeId: 'manual',
        configurationReady: true, configurationRevision: null, expiresAt: 20 });
    const authentication = PluginConnectedAccountAuthenticationV2Schema.parse({ defaultModeId: 'manual', modes: [
        { id: 'manual', kind: 'manual', outcomeReconciliation: 'none', fields: [] },
    ] });
    const repair = { actionId: 'connectedServices.authentication.beginReconnect' as const,
        input: { machineId: 'machine-1', account } };
    const setup: Parameters<typeof readSessionPersonalCredentialReadiness>[0] = {
        current: true, purpose, serviceRefs: [service], bindings: { v: 1, bindings: [
            { purpose, target: { kind: 'account', account } },
        ] }, accounts: [profile], groups: [], now: 30, readAuthentication: () => authentication,
        mayRepair: true, repair,
    };
    const credential = readSessionPersonalCredentialReadiness(setup);
    expect(credential).toEqual({ kind: 'personal', purpose, usable: false, repair });
    expect(readSessionPersonalCredentialReadiness({ ...setup, current: false }))
        .toEqual({ kind: 'personal', purpose, usable: null, repair: null });
    expect(readSessionPersonalCredentialReadiness({ ...setup, mayRepair: false }))
        .toEqual({ kind: 'personal', purpose, usable: false, repair: null });
    const ready = projectMachineAgent({ agentId: facts.agentId, title: facts.title,
        facts: { ...facts, signIn: { ...facts.signIn, status: 'signedIn' } },
        checking: false, stale: false, connectedServices: [], job: null });
    const vm = buildSessionReadinessViewModel({ ...input, agent: ready, operation: 'credential', credential });
    expect(vm).toMatchObject({ readiness: { status: 'unavailable', cause: 'credential' }, repair });
    expect(buildSessionReadinessViewModel({ ...input, agent: ready, credential }))
        .toMatchObject({ readiness: { status: 'ready', cause: null }, repair: null });
    expect(SessionReadinessV1Schema.parse(vm.readiness)).toEqual(vm.readiness);
});
