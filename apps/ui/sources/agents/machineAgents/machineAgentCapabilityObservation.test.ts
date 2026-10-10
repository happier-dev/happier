import { describe, expect, it } from 'vitest';
import { projectMachineAgentCapabilityObservation } from './machineAgentCapabilityObservation';
import { createMachineAgentInventoryStore } from './machineAgentInventoryStore';
import { isMachineAgentReady } from './resolveMachineAgentState';

describe('machine agent capability observation', () => {
    it('uses installed rather than legacy available, fails closed on incomplete rows, and preserves the last-known offline facts', () => {
        const descriptors = [{ agentId: 'antigravity', title: 'Antigravity' }];
        const row = { available: true, installed: false, version: null, latestVersion: null, update: { supported: false, command: null }, signIn: { status: 'signedIn', loginSupport: 'manual_only' }, platform: { supported: true }, install: { available: true, mode: 'vendor_recipe', sizeBytes: null, guideUrl: null }, dependencies: [{ key: 'agy-helper', installed: true, version: '1' }] };
        const cache = { status: 'loaded' as const, snapshot: { response: { protocolVersion: 1 as const, results: { 'cli.antigravity': { ok: true as const, checkedAt: 12, data: row } } } } };
        const store = createMachineAgentInventoryStore();
        store.publish('machine', projectMachineAgentCapabilityObservation(descriptors, cache));
        expect(store.read('machine')).toMatchObject({ status: 'ready', lastCheckedAt: 12, agents: [{ installed: false, state: 'notInstalled' }] });
        store.publish('machine', projectMachineAgentCapabilityObservation(descriptors, { status: 'loaded', snapshot: { response: { protocolVersion: 1, results: { 'cli.antigravity': { ok: true, checkedAt: 13, data: { available: true } } } } } }));
        expect(store.read('machine')).toMatchObject({ status: 'ready', agents: [{ installed: false, state: 'unknown', stale: true, unavailableReason: { reason: 'invalid_facts' } }] });
    });

    it('keeps a ready Agent fresh when another fails, and requires successful re-detection to recover', () => {
        const descriptors = [{ agentId: 'claude', title: 'Claude' }, { agentId: 'codex', title: 'Codex' }];
        const row = { installed: true, version: '1', latestVersion: null, update: { supported: false, command: null },
            signIn: { status: 'signedIn', loginSupport: 'login_terminal' }, platform: { supported: true },
            install: { available: true, mode: 'managed', sizeBytes: null, guideUrl: null }, dependencies: [] };
        const store = createMachineAgentInventoryStore();
        const success = { ok: true as const, checkedAt: 12, data: row };
        store.publish('machine', projectMachineAgentCapabilityObservation(descriptors, { status: 'loaded', snapshot: {
            response: { protocolVersion: 1, results: { 'cli.claude': success, 'cli.codex': success } },
        } }));
        const priorClaude = store.read('machine').agents[0];
        store.publish('machine', projectMachineAgentCapabilityObservation(descriptors, { status: 'loaded', snapshot: {
            response: { protocolVersion: 1, results: { 'cli.claude': success, 'cli.codex': {
                ok: false, checkedAt: 13, error: { code: 'unknown-capability', message: 'Unknown capability' },
            } } },
        } }));
        const snapshot = store.read('machine');
        expect(snapshot.status).toBe('ready');
        expect(snapshot.agents[0]).toBe(priorClaude);
        expect(isMachineAgentReady(snapshot.agents[0])).toBe(true);
        expect(snapshot.agents[1]).toMatchObject({ installed: true, state: 'unknown', stale: true,
            unavailableReason: { reason: 'probe_failed', errorCode: 'unknown-capability' } });
        expect(isMachineAgentReady(snapshot.agents[1])).toBe(false);
        store.publishJobs('machine', new Map());
        expect(isMachineAgentReady(store.read('machine').agents[1])).toBe(false);
        store.publish('machine', projectMachineAgentCapabilityObservation(descriptors, { status: 'loaded', snapshot: {
            response: { protocolVersion: 1, results: { 'cli.claude': success, 'cli.codex': { ...success, checkedAt: 14 } } },
        } }));
        expect(isMachineAgentReady(store.read('machine').agents[1])).toBe(true);
        expect(store.read('machine').agents[1].unavailableReason).toBeUndefined();
    });
});
