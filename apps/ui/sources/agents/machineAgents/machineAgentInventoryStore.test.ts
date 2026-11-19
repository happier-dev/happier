import { describe, expect, it, vi } from 'vitest';
import type { MachineAgentInventoryItem } from '@happier-dev/protocol/capabilities';
import { createMachineAgentInventoryStore } from './machineAgentInventoryStore';
import { resolveAgentSetupPhase, resolveMachineAgentStatus } from '@/components/machines/agents/machineAgentPresentation';
import { isMachineAgentReady } from './resolveMachineAgentState';
import { resolveAgentCatalogProjection } from '@/agents/backendCatalog/agentCatalogProjection';
import { buildAgentCollection } from '@/components/settings/agents/collection/agentCollectionModel';
import { createMachineAgentInventoryPersistence } from './machineAgentInventoryPersistence';
import { projectMachineAgentCapabilityObservation } from './machineAgentCapabilityObservation';
import { projectMachineAgentForCredential } from './machineAgentModel';
import type { MachineAgent } from './machineAgentTypes';

const facts = (agentId: string): MachineAgentInventoryItem => ({ agentId, title: agentId, installed: true,
    version: '1.0.0', latestVersion: '1.0.0', update: { supported: true, command: null },
    signIn: { status: 'signedIn', loginSupport: 'login_terminal' }, platform: { supported: true },
    install: { available: true, mode: 'managed', sizeBytes: null, guideUrl: null }, dependencies: [] });

describe('machine agent inventory store', () => {
    it('summarizes a configured ACP instance across bare and qualified inventory ids', () => {
        const store = createMachineAgentInventoryStore();
        store.publish('machine', { status: 'ready', items: [{
            ...facts('happier.agent.custom-acp/custom-acp'), definitionId: 'qa-foldseed-acp',
        }], lastCheckedAt: 1 });
        expect(store.createHeldAgentSummary(['machine'], 'custom-acp', 'qa-foldseed-acp').getSnapshot())
            .toEqual({ machineCount: 1, versions: ['1.0.0'], unknownVersionCount: 0, complete: true });
        expect(store.createHeldAgentSummary(['machine'], 'custom-acp', 'another-definition').getSnapshot().machineCount).toBe(0);
    });

    it('retains a cold classified failure without inventing Agents and publishes only a changed reason', () => {
        const store = createMachineAgentInventoryStore();
        const changed = vi.fn();
        const off = store.subscribe('cold-machine', changed);
        const failed = { status: 'error' as const, items: [], lastCheckedAt: null,
            failure: { reason: 'probe_failed' as const, errorCode: 'access-denied' } };
        store.publish('cold-machine', failed);
        const first = store.read('cold-machine');
        expect(first.agents).toEqual([]);
        expect(resolveMachineAgentStatus(null, undefined, first.status, first.failure)).toMatchObject({
            kind: 'unavailable', reason: { errorCode: 'access-denied' },
        });
        for (let index = 0; index < 20; index++) store.publish('cold-machine', { ...failed, failure: { ...failed.failure } });
        expect(store.read('cold-machine')).toBe(first);
        expect(changed).toHaveBeenCalledTimes(1);
        store.publish('cold-machine', { ...failed, failure: { ...failed.failure, errorCode: 'transport-unavailable' } });
        expect(changed).toHaveBeenCalledTimes(2);
        expect(store.read('cold-machine').failure?.errorCode).toBe('transport-unavailable');
        store.publish('cold-machine', { status: 'ready', items: [facts('codex')], lastCheckedAt: 1 });
        expect(store.read('cold-machine')).not.toHaveProperty('failure');
        expect(isMachineAgentReady(store.read('cold-machine').agents[0])).toBe(true);
        off();
    });

    it.each([
        { name: 'member-negative/global-positive', installed: false, installedAgentIds: ['claude'] },
        { name: 'member-positive/global-negative', installed: true, installedAgentIds: [] },
    ])('keeps $name Claude installation scoped across Machine metadata publications', ({ installed, installedAgentIds }) => {
        const store = createMachineAgentInventoryStore();
        const native = facts('claude');
        const member = { ...native, installed, version: installed ? '2.1.328' : null,
            signIn: { ...native.signIn, status: 'signedOut' as const },
            install: { ...native.install, executionScope: 'member' as const } };
        store.publish('machine', { status: 'ready', items: [member], lastCheckedAt: 100,
            installedAgentIds, installedAgentsCheckedAt: 200 });
        const first = store.read('machine').agents[0];
        expect(first).toMatchObject({ installed, version: member.version });
        expect(store.readObservedItems('machine', [member])).toEqual([member]);

        store.publish('machine', { status: 'ready', items: [], lastCheckedAt: null,
            installedAgentIds, installedAgentsCheckedAt: 300 });
        expect(store.read('machine').agents[0]).toBe(first);

        const published = { installedAgentIds, checkedAt: 300 };
        expect(store.createHeldAgentSummary(['machine'], 'claude', undefined, new Map([['machine', published]]))
            .getSnapshot().machineCount).toBe(installed ? 1 : 0);

        const values = new Map<string, string>();
        const persistence = createMachineAgentInventoryPersistence({
            getString: key => values.get(key), set: (key, value) => { values.set(key, value); },
        });
        const scope = { serverId: 'home', accountId: 'member' };
        persistence.write(scope, 'machine', { items: [...store.readObservedItems('machine', [member])], lastCheckedAt: 100 });
        const saved = persistence.read(scope, 'machine')!;
        const reopened = createMachineAgentInventoryStore();
        reopened.read('machine', () => ({ ...saved, status: 'offline' }));
        reopened.publish('machine', { status: 'loading', items: [], lastCheckedAt: null,
            installedAgentIds, installedAgentsCheckedAt: 300 });
        expect(reopened.read('machine').agents[0]).toMatchObject({ installed, install: { executionScope: 'member' } });
    });

    it('orders a succeeded member install against its member check', () => {
        const store = createMachineAgentInventoryStore();
        const native = facts('claude');
        const member = { ...native, installed: false, version: null, install: { ...native.install, executionScope: 'member' as const } };
        const descriptors = [{ agentId: 'claude', title: 'Claude' }, { agentId: 'codex', title: 'Codex' }];
        const checked = (memberCheckedAt: number) => projectMachineAgentCapabilityObservation(descriptors, {
            status: 'loaded', snapshot: { response: { protocolVersion: 1, results: {
                'cli.claude': { ok: true, checkedAt: memberCheckedAt, data: member },
                'cli.codex': { ok: true, checkedAt: 350, data: facts('codex') },
            } } },
        });
        store.publish('machine', { ...checked(100), installedAgentIds: [], installedAgentsCheckedAt: 300 });
        const job = { jobId: 'install', intent: 'install' as const, startedAtMs: 200, steps: [], logLine: null,
            outcome: { kind: 'succeeded' as const, version: '2.1.328' } };
        store.publishJobs('machine', new Map([['claude', { ...job, executionScope: 'machine' }]]));
        expect(store.read('machine').agents[0]).toMatchObject({ installed: false, version: null });
        store.publishJobs('machine', new Map([['claude', { ...job, executionScope: 'member' }]]));
        expect(store.read('machine').agents[0]).toMatchObject({ installed: true, version: '2.1.328' });
        store.publish('machine', { status: 'ready', items: [], lastCheckedAt: null,
            installedAgentIds: [], installedAgentsCheckedAt: 400 });
        expect(store.read('machine').agents[0]).toMatchObject({ installed: true, version: '2.1.328' });
        store.publish('machine', { ...checked(500), installedAgentIds: [], installedAgentsCheckedAt: 400 });
        expect(store.read('machine').agents[0]).toMatchObject({ installed: false, version: null });
    });

    it('settles a succeeded install over installation facts checked before it, and yields to a later check', () => {
        const store = createMachineAgentInventoryStore();
        const absent: MachineAgentInventoryItem = { ...facts('pi'), installed: false, version: null, latestVersion: null,
            signIn: { status: 'unknown', loginSupport: 'login_terminal' } };
        store.publish('machine', { status: 'ready', items: [absent], installedAgentIds: [], installedAgentsCheckedAt: 100, lastCheckedAt: 1 });
        const job = (outcome: NonNullable<MachineAgent['job']>['outcome']): NonNullable<MachineAgent['job']> => ({
            jobId: 'job-1', intent: 'install', startedAtMs: 200, steps: [], logLine: null, outcome });
        store.publishJobs('machine', new Map([['pi', job(null)]]));
        expect(resolveAgentSetupPhase(store.read('machine').agents[0]!)).toBe('installing');

        store.publishJobs('machine', new Map([['pi', job({ kind: 'succeeded', version: '0.9.1' })]]));
        const settled = store.read('machine').agents[0]!;
        expect(settled).toMatchObject({ installed: true, version: '0.9.1' });
        expect(resolveAgentSetupPhase(settled)).not.toBe('install');
        // The Machine's echo of that same pre-install check changes nothing.
        store.publish('machine', { status: 'ready', items: [absent], installedAgentIds: [], installedAgentsCheckedAt: 100, lastCheckedAt: 2 });
        expect(store.read('machine').agents[0]).toMatchObject({ installed: true });

        // A check made after the job started is newer than the job: it wins either way.
        store.publish('machine', { status: 'ready', items: [absent], installedAgentIds: [], installedAgentsCheckedAt: 300, lastCheckedAt: 3 });
        expect(store.read('machine').agents[0]).toMatchObject({ installed: false });
    });

    it('initializes the first snapshot silently once per key and still publishes later real changes', () => {
        const store = createMachineAgentInventoryStore();
        const readSaved = vi.fn(() => ({ status: 'offline' as const, items: [facts('claude')], lastCheckedAt: 1 }));
        const changed = vi.fn();
        const agentChanged = vi.fn();
        const off = store.subscribe('machine', changed);
        const offAgent = store.subscribeAgent('machine', 'claude', agentChanged);
        const first = store.read('machine', readSaved);
        expect(first.agents[0]).toMatchObject({ agentId: 'claude', version: '1.0.0', stale: true });
        expect(store.read('machine', readSaved)).toBe(first);
        expect(readSaved).toHaveBeenCalledTimes(1);
        expect(changed).not.toHaveBeenCalled();
        expect(agentChanged).not.toHaveBeenCalled();
        const readEmpty = vi.fn(() => null);
        expect(store.read('other-account/machine', readEmpty).agents).toEqual([]);
        store.read('other-account/machine', readEmpty);
        expect(readEmpty).toHaveBeenCalledTimes(1);
        store.publish('machine', { status: 'ready', items: [{ ...facts('claude'), version: '2.0.0' }], lastCheckedAt: 2 });
        expect(store.read('machine', readSaved).agents[0]).toMatchObject({ version: '2.0.0', stale: false });
        expect(changed).toHaveBeenCalledTimes(1);
        expect(agentChanged).toHaveBeenCalledTimes(1);
        expect(readSaved).toHaveBeenCalledTimes(1);
        off(); offAgent();
    });

    it('retains hydrated attention rows through catalog observation until Account authentication settles', () => {
        const store = createMachineAgentInventoryStore();
        const values = new Map<string, string>();
        const persistence = createMachineAgentInventoryPersistence({
            getString: key => values.get(key), set: (key, value) => { values.set(key, value); },
        });
        const scope = { serverId: 'home', accountId: 'alice' };
        const items = ['claude', 'codex'].map(agentId => ({ ...facts(agentId),
            signIn: { status: 'signedOut' as const, loginSupport: 'login_terminal' as const } }));
        items.push({ ...facts('antigravity'), installed: false,
            signIn: { status: 'signedOut', loginSupport: 'login_terminal' } });
        const descriptors = items.map(({ agentId, title }) => ({ agentId, title }));
        const entries = descriptors.map(({ agentId }) => resolveAgentCatalogProjection(agentId, { enabledAgentIds: [] }));
        const collection = () => buildAgentCollection({ entries, agents: store.read('machine').agents, query: '' });
        // The home reserves these last-known rows until it can assert verified trouble.
        const attentionKeys = () => collection().onMachine.filter(row => row.trouble || row.status === 'needsSignIn').map(row => row.key);
        persistence.write(scope, 'machine', { items, lastCheckedAt: 1 });
        const saved = persistence.read(scope, 'machine');
        if (!saved) throw new Error('Expected the persisted inventory fixture');
        store.publish('machine', { ...saved, status: 'offline' }); // hydrate
        expect(attentionKeys()).toEqual(['claude', 'codex']);
        expect(collection().onMachine.filter(row => row.trouble)).toHaveLength(0);
        const hydrated = store.read('machine').agents;
        const changes = vi.fn();
        const off = store.subscribeAgent('machine', 'claude', changes);
        const credentialSelectionsByAgentId = Object.fromEntries(descriptors.map(({ agentId }) => [agentId, {
            credentialBindings: null, credentialBindingsReady: false,
        }]));
        const pending = projectMachineAgentCapabilityObservation(descriptors, { status: 'idle' }, hydrated);
        // observe: the catalog now exists, but the Account purpose read and native probe have not settled.
        store.publish('machine', { ...pending, credentialSelectionsByAgentId });
        expect(attentionKeys()).toEqual(['claude', 'codex']);
        expect(store.read('machine').agents[0].signIn.status).toBe('unknown');
        expect(changes).toHaveBeenCalledTimes(1); // The Account credential choice is now explicitly unread.
        const pendingAgents = store.read('machine').agents;
        store.publish('machine', { ...pending, credentialSelectionsByAgentId });
        expect(store.read('machine').agents).toBe(pendingAgents);
        expect(changes).toHaveBeenCalledTimes(1);
        const detected = projectMachineAgentCapabilityObservation(descriptors, { status: 'loaded', snapshot: {
            response: { protocolVersion: 1, results: Object.fromEntries(items.map(item => [`cli.${item.agentId}`, {
                ok: true, checkedAt: 2, data: item,
            }])) },
        } }, store.read('machine').agents);
        store.publish('machine', { ...detected, credentialSelectionsByAgentId });
        expect(attentionKeys()).toEqual(['claude', 'codex']);
        expect(changes).toHaveBeenCalledTimes(2); // Native installation freshness settled, not the credential choice.
        const detectedAgents = store.read('machine').agents;
        for (let arrival = 0; arrival < 3; arrival++) store.publish('machine', { ...detected, credentialSelectionsByAgentId });
        expect(store.read('machine').agents).toBe(detectedAgents);
        expect(changes).toHaveBeenCalledTimes(2);
        expect(isMachineAgentReady(store.read('machine').agents[0])).toBe(false);
        expect(collection().available.map(row => row.key)).toEqual(['antigravity']);
        // Retaining attention must not swallow independently verified installation/version changes.
        store.publish('machine', { ...detected, items: detected.items.map(item => item.agentId === 'claude'
            ? { ...item, version: '2.0.0' } : item), credentialSelectionsByAgentId });
        expect(store.read('machine').agents[0].version).toBe('2.0.0');
        expect(store.read('machine').agents[1]).toBe(detectedAgents[1]);
        expect(attentionKeys()).toEqual(['claude', 'codex']);
        expect(changes).toHaveBeenCalledTimes(3);
        const settledCredentials = Object.fromEntries(descriptors.map(({ agentId }) => [agentId, {
            credentialBindings: null, credentialBindingsReady: true,
        }]));
        store.publish('machine', { status: 'ready', items: [], descriptors, lastCheckedAt: 2,
            credentialSelectionsByAgentId: settledCredentials });
        expect(collection().onMachine.filter(row => row.trouble).map(row => row.key)).toEqual(['claude', 'codex']);
        expect(changes).toHaveBeenCalledTimes(4);
        const available = store.read('machine').agents[2];
        store.publish('machine', { status: 'ready', items: [facts('claude'), facts('codex')], descriptors, lastCheckedAt: 3 });
        expect(attentionKeys()).toEqual([]);
        expect(isMachineAgentReady(store.read('machine').agents[0])).toBe(true);
        expect(changes).toHaveBeenCalledTimes(5);
        expect(store.read('machine').agents[2]).toBe(available);
        expect(store.read('another-account/machine').agents).toEqual([]);
        off();
    });

    it('retains fresh native authentication for an explicit Session choice while Account defaults are unread', () => {
        const store = createMachineAgentInventoryStore();
        store.publish('machine', { status: 'offline', lastCheckedAt: 1, items: [{ ...facts('claude'),
            signIn: { status: 'signedOut', loginSupport: 'login_terminal' },
        }] });
        store.publish('machine', { status: 'ready', items: [facts('claude')], lastCheckedAt: 2,
            credentialSelectionsByAgentId: { claude: { credentialBindings: null, credentialBindingsReady: false } },
        });
        const agent = store.read('machine').agents[0];
        expect(agent.signIn.native?.status).toBe('signedIn');
        expect(agent.signIn.status).toBe('unknown');
        expect(isMachineAgentReady(agent)).toBe(false);
        expect(isMachineAgentReady(projectMachineAgentForCredential(agent, { credentialBindings: null }))).toBe(true);
    });

    it.each(['removed', 'unsupported', 'unavailable'] as const)('settles a hydrated Agent that is %s even while Account authentication is unread', (outcome) => {
        const store = createMachineAgentInventoryStore();
        const signedOut = { ...facts('claude'), signIn: { status: 'signedOut' as const, loginSupport: 'login_terminal' as const } };
        store.publish('machine', { status: 'offline', items: [signedOut], lastCheckedAt: 1 });
        const changed = vi.fn();
        const off = store.subscribeAgent('machine', 'claude', changed);
        store.publish('machine', { status: 'ready', lastCheckedAt: 2,
            items: outcome === 'unavailable' ? [] : [{ ...signedOut,
                ...(outcome === 'removed' ? { installed: false } : { platform: { supported: false, reason: 'os' } }),
            }],
            ...(outcome === 'unavailable' ? { unavailable: [{ agentId: 'claude', reason: 'probe_failed' as const }] } : {}),
            credentialSelectionsByAgentId: { claude: { credentialBindings: null, credentialBindingsReady: false } },
        });
        expect(store.read('machine').agents[0].state).toBe(outcome === 'removed' ? 'notInstalled' : outcome === 'unsupported' ? 'unsupported' : 'unknown');
        expect(isMachineAgentReady(store.read('machine').agents[0])).toBe(false);
        expect(changed).toHaveBeenCalledTimes(1);
        off();
    });

    it('retains last-known sign-in trouble until a verified result settles without granting readiness', () => {
        const store = createMachineAgentInventoryStore();
        const signedOut = { ...facts('claude'), signIn: { status: 'signedOut' as const, loginSupport: 'login_terminal' as const } };
        const entries = [resolveAgentCatalogProjection('claude', { enabledAgentIds: [] })];
        const collection = (key = 'machine') => buildAgentCollection({ entries, agents: store.read(key).agents, query: '' });
        // A cold native snapshot alone does not prove the Account's effective credential choice.
        store.publish('cold', { status: 'offline', items: [signedOut], lastCheckedAt: 1 });
        expect(collection('cold').onMachine[0].trouble).toBe(false);
        store.publish('machine', { status: 'ready', items: [signedOut], lastCheckedAt: 1 });
        expect(collection().onMachine[0].trouble).toBe(true);
        store.publish('machine', { status: 'offline', items: [], lastCheckedAt: null });
        expect(collection().onMachine[0].trouble).toBe(true);
        expect(isMachineAgentReady(store.read('machine').agents[0])).toBe(false);
        const pending = { status: 'loading' as const, items: [], lastCheckedAt: null,
            credentialSelectionsByAgentId: { claude: { credentialBindings: null, credentialBindingsReady: false } } };
        store.publish('machine', pending);
        expect(store.read('machine').agents[0].state).toBe('unknown');
        expect(collection().onMachine[0].trouble).toBe(true);
        expect(isMachineAgentReady(store.read('machine').agents[0])).toBe(false);
        const prior = store.read('machine').agents[0];
        const changed = vi.fn();
        const dispose = store.subscribeAgent('machine', 'claude', changed);
        store.publish('machine', pending);
        expect(store.read('machine').agents[0]).toBe(prior);
        expect(changed).not.toHaveBeenCalled();
        // Inventory completion is not credential verification while its Account choice is unread.
        store.publish('machine', { ...pending, status: 'ready' });
        expect(collection().onMachine[0].trouble).toBe(true);
        expect(isMachineAgentReady(store.read('machine').agents[0])).toBe(false);
        expect(changed).toHaveBeenCalledTimes(1); // Installation freshness settled, not the credential choice.
        const inventorySettled = store.read('machine').agents[0];
        store.publish('machine', { ...pending, status: 'ready' });
        expect(store.read('machine').agents[0]).toBe(inventorySettled);
        expect(changed).toHaveBeenCalledTimes(1);
        store.publish('machine', { status: 'ready', items: [facts('claude')], lastCheckedAt: 2,
            credentialSelectionsByAgentId: { claude: { credentialBindings: null, credentialBindingsReady: true } } });
        expect(collection().onMachine[0].trouble).toBe(false);
        expect(isMachineAgentReady(store.read('machine').agents[0])).toBe(true);
        expect(changed).toHaveBeenCalledTimes(2);
        expect(store.read('another-account/machine').agents).toEqual([]);
        dispose();
    });

    it.each(['idle', 'loading'] as const)('retains last-known freshness during %s and publishes Agent changes only when observations settle', (status) => {
        const store = createMachineAgentInventoryStore();
        const signedOut = { ...facts('claude'), signIn: { status: 'signedOut' as const, loginSupport: 'login_terminal' as const } };
        store.publish('machine', { status: 'offline', items: [signedOut], lastCheckedAt: 1 });
        const lastKnown = store.read('machine').agents[0];
        const changed = vi.fn();
        const dispose = store.subscribeAgent('machine', 'claude', changed);
        store.publish('machine', { status, items: [], lastCheckedAt: null });
        expect(store.read('machine').agents[0]).toBe(lastKnown);
        expect(changed).not.toHaveBeenCalled();
        store.publish('machine', { status: 'ready', items: [signedOut], lastCheckedAt: 2 });
        const current = store.read('machine').agents[0];
        expect(current).toMatchObject({ state: 'needsSignIn', stale: false });
        expect(changed).toHaveBeenCalledTimes(1);
        store.publish('machine', { status, items: [], lastCheckedAt: null });
        expect(store.read('machine').agents[0]).toBe(current);
        expect(changed).toHaveBeenCalledTimes(1);
        store.publish('machine', { status: 'ready', items: [facts('claude')], lastCheckedAt: 3 });
        expect(store.read('machine').agents[0]).toMatchObject({ state: 'ready', stale: false });
        expect(changed).toHaveBeenCalledTimes(2);
        dispose();
    });

    it('keeps a native Agent summary complete when unrelated configured instances have not been read', () => {
        const store = createMachineAgentInventoryStore();
        const keys = ['active', 'cold'];
        const published = new Map(keys.map(key => [key, { checkedAt: 1, installedAgentIds: ['claude', 'custom-acp'] }]));
        store.publish('active', { status: 'ready', items: [{ ...facts('claude'), version: '2.1.4' }], lastCheckedAt: 1 });
        const summary = store.createHeldAgentSummary(keys, 'claude', undefined, published);
        expect(summary.getSnapshot()).toEqual({ machineCount: 2, versions: ['2.1.4'], unknownVersionCount: 1, complete: true });
        // An unread configured instance stays unknown; a factory never proves its installation.
        expect(store.createHeldAgentSummary(keys, 'custom-acp', 'review', published).getSnapshot())
            .toEqual({ machineCount: 0, versions: [], unknownVersionCount: 0, complete: false });
        // A genuinely unobserved Machine still prevents an exact total.
        expect(store.createHeldAgentSummary([...keys, 'unobserved'], 'claude', undefined, published).getSnapshot().complete).toBe(false);
    });

    it('projects held installed counts and all reported versions without notifying for unrelated arrivals', () => {
        const store = createMachineAgentInventoryStore();
        const keys = Array.from({ length: 139 }, (_, i) => `account-a/machine-${i}`);
        for (const key of keys) store.publish(key, { status: 'ready', items: [facts('claude'), facts('codex')], lastCheckedAt: 1 });
        const summary = store.createHeldAgentSummary(keys, 'claude');
        expect(summary.getSnapshot()).toEqual({ machineCount: 139, versions: ['1.0.0'], unknownVersionCount: 0, complete: true });
        const initial = summary.getSnapshot();
        const changed = vi.fn();
        const off = summary.subscribe(changed);
        for (const key of keys) store.publish(key, { status: 'offline', items: [], lastCheckedAt: 2 });
        store.publish(keys[0]!, { status: 'ready', items: [facts('claude'), { ...facts('codex'), version: '9' }], lastCheckedAt: 3 });
        store.publish('account-b/machine-0', { status: 'ready', items: [{ ...facts('claude'), version: 'wrong-account' }], lastCheckedAt: 3 });
        expect(summary.getSnapshot()).toBe(initial);
        expect(changed).not.toHaveBeenCalled();
        store.publish(keys[0]!, { status: 'ready', items: [{ ...facts('claude'), version: '2.1.4' }], lastCheckedAt: 4 });
        expect(summary.getSnapshot()).toEqual({ machineCount: 139, versions: ['1.0.0', '2.1.4'], unknownVersionCount: 0, complete: true });
        store.publish(keys[1]!, { status: 'ready', items: [{ ...facts('claude'), version: null }], lastCheckedAt: 5 });
        expect(summary.getSnapshot()).toEqual({ machineCount: 139, versions: ['1.0.0', '2.1.4'], unknownVersionCount: 1, complete: true });
        store.publish(keys[0]!, { status: 'ready', items: [{ ...facts('claude'), installed: false, version: null }], lastCheckedAt: 6 });
        expect(summary.getSnapshot()).toEqual({ machineCount: 138, versions: ['1.0.0'], unknownVersionCount: 1, complete: true });
        off();
    });
    it('keeps two ACP definitions separate and retains the unchanged definition identity', () => {
        const store = createMachineAgentInventoryStore();
        const first = { ...facts('custom-acp'), definitionId: 'first', title: 'First' };
        const second = { ...facts('custom-acp'), definitionId: 'second', title: 'Second', version: '2.0' };
        store.publish('machine', { status: 'ready', items: [first, second], lastCheckedAt: 1 });
        const initial = store.read('machine').agents;
        expect(Reflect.set(initial[0], 'definitionId', 'second')).toBe(false);
        expect(Reflect.set(initial, '0', initial[1])).toBe(false);
        expect(initial.map(agent => [agent.definitionId, agent.version])).toEqual([['first', '1.0.0'], ['second', '2.0']]);
        store.publish('machine', { status: 'ready', items: [first, { ...second, version: '3.0' }], lastCheckedAt: 2 });
        expect(store.read('machine').agents[0]).toBe(initial[0]);
        expect(store.read('machine').agents[1].version).toBe('3.0');
    });
    it('distinguishes failed checks from offline presence without admitting retained facts', () => {
        const store = createMachineAgentInventoryStore();
        const ready = { status: 'ready' as const, items: [facts('claude')], lastCheckedAt: 1 };
        store.publish('machine', ready);
        store.publish('machine', { status: 'error', items: [], lastCheckedAt: null });
        const failed = store.read('machine').agents[0];
        expect(failed.installed).toBe(true);
        expect(resolveMachineAgentStatus(failed)).toEqual({ kind: 'unknown', tone: 'quiet' });
        expect(isMachineAgentReady(failed)).toBe(false);

        store.publish('machine', { status: 'offline', items: [], lastCheckedAt: null });
        expect(resolveMachineAgentStatus(store.read('machine').agents[0])).toEqual({ kind: 'offline', tone: 'quiet', lastKnown: 'signedIn' });

        store.publish('machine', { status: 'ready', items: [], unavailable: [{ agentId: 'claude', reason: 'probe_failed' }], lastCheckedAt: 2 });
        expect(resolveMachineAgentStatus(store.read('machine').agents[0])).toEqual({ kind: 'unavailable', tone: 'quiet', reason: { reason: 'probe_failed' } });
        expect(isMachineAgentReady(store.read('machine').agents[0])).toBe(false);

        store.publish('machine', { status: 'offline', items: [], lastCheckedAt: null });
        expect(resolveMachineAgentStatus(store.read('machine').agents[0]).kind).toBe('offline');
        store.publish('machine', ready);
        expect(resolveMachineAgentStatus(store.read('machine').agents[0]).kind).toBe('ready');
        expect(isMachineAgentReady(store.read('machine').agents[0])).toBe(true);
    });

    it('retains offline facts and identities, suppresses no-op notifications, and isolates machine/account scopes', () => {
        const store = createMachineAgentInventoryStore();
        const listener = vi.fn();
        store.subscribe('account-a/machine', listener);
        const observation = { status: 'ready' as const, items: [facts('claude'), facts('codex')], lastCheckedAt: 1 };
        store.publish('account-a/machine', observation);
        const first = store.read('account-a/machine');
        const claudeListener = vi.fn();
        store.subscribeAgent('account-a/machine', 'claude', claudeListener);
        expect(first.agents.map((agent) => agent.state)).toEqual(['ready', 'ready']);
        store.publish('account-a/machine', observation);
        expect(store.read('account-a/machine')).toBe(first);
        expect(listener).toHaveBeenCalledTimes(1);
        store.publish('account-a/machine', { ...observation, items: [facts('claude'), { ...facts('codex'), latestVersion: '2.0.0' }], lastCheckedAt: 2 });
        expect(store.read('account-a/machine').agents[0]).toBe(first.agents[0]);
        expect(claudeListener).not.toHaveBeenCalled();
        store.publish('account-a/machine', { status: 'offline', items: [], lastCheckedAt: null });
        expect(store.read('account-a/machine')).toMatchObject({ status: 'offline', lastCheckedAt: 2, agents: [{ installed: true, stale: true }, { installed: true, stale: true }] });
        expect(store.read('account-b/machine').agents).toEqual([]);
        expect(claudeListener).toHaveBeenCalledTimes(1);
    });
});
