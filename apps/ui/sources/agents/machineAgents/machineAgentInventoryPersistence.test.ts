import { describe, expect, it, vi } from 'vitest';
import { MachineAgentInventoryItemSchema } from '@happier-dev/protocol/capabilities';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { serverAccountScopedStorageKey } from '@/sync/domains/scope/serverAccountScope';
import { resolveMachineAgentRowAction, resolveMachineAgentStatus } from '@/components/machines/agents/machineAgentPresentation';
import { createMachineAgentInventoryStore } from './machineAgentInventoryStore';
import { createMachineAgentInventoryPersistence } from './machineAgentInventoryPersistence';

async function storageBoundary() {
    const browser = await installBrowserRuntimeForTests({ url: 'https://inventory-persistence.test' });
    const storage = {
        getString: (key: string) => browser.storage.getItem(key) ?? undefined,
        set: (key: string, value: string) => browser.storage.setItem(key, value),
    };
    return { browser, storage, persistence: createMachineAgentInventoryPersistence(storage) };
}

const scope = { serverId: 'home', accountId: 'alice' };
const storageKey = serverAccountScopedStorageKey('machine-agents:v1:"machine"', scope);
const fullInventory = {
    lastCheckedAt: 123,
    items: Array.from({ length: 24 }, (_, index) => MachineAgentInventoryItemSchema.parse({
        agentId: index < 22 ? `agent-${index}` : 'custom-acp',
        ...(index < 22 ? {} : { definitionId: `configured-${index}` }),
        title: `Coding agent ${index}`, installed: index !== 2, managed: index % 2 === 0,
        version: '1.2.3', latestVersion: '1.3.0', update: { supported: index % 2 === 0, command: `npm update -g agent-${index}` },
        signIn: { status: index === 1 ? 'signedOut' : index === 6 ? 'unknown' : 'signedIn',
            required: index !== 6, loginSupport: 'login_terminal', accountLabel: `Native account ${index}` },
        platform: index === 3 ? { supported: false, reason: 'arch' } : { supported: true },
        ...(index === 4 ? { fit: { kind: 'cant_run', reason: 'no_build_for_platform' } }
            : index === 5 ? { fit: { kind: 'unknown', reason: 'platform_unknown' } } : {}),
        install: { available: true, mode: 'vendor_recipe', sizeBytes: 200_000_000,
            guideUrl: `https://vendor.example.test/agent-${index}/installation?steps=${'read-the-vendor-guide-'.repeat(12)}` },
        dependencies: Array.from({ length: 5 }, (_, dependency) => ({ key: `runtime-${dependency}`,
            installed: !(index === 7 && dependency === 0), version: `20.${dependency}.1` })),
    })),
};

function coldPresentation(snapshot: typeof fullInventory) {
    const store = createMachineAgentInventoryStore();
    const restored = store.read('cold', () => ({ ...snapshot, status: 'offline' }));
    return { lastCheckedAt: restored.lastCheckedAt, rows: restored.agents.map(agent => ({
        agentId: agent.agentId, definitionId: agent.definitionId, title: agent.title,
        installed: agent.installed, managed: agent.managed, version: agent.version, latestVersion: agent.latestVersion,
        state: agent.state, signIn: agent.signIn, update: agent.update, platform: agent.platform,
        status: resolveMachineAgentStatus(agent), action: resolveMachineAgentRowAction(agent),
    })) };
}

const compactKeys = new Set(['agentId', 'definitionId', 'title', 'installed', 'managed', 'version', 'latestVersion',
    'updateSupported', 'updateCommand', 'signInStatus', 'signInRequired', 'loginSupport', 'accountLabel',
    'platform', 'fit', 'missingDependencies']);

describe('machine agent last-known persistence', () => {
    it('recovers an exact account/machine snapshot and fails closed on foreign scope or malformed rows', async () => {
        const { browser, storage, persistence } = await storageBoundary();
        const snapshot = { items: [], lastCheckedAt: 123 };
        try {
            persistence.write(scope, 'machine', snapshot);
            expect(persistence.read(scope, 'machine')).toEqual(snapshot);
            expect(persistence.read({ ...scope, accountId: 'bob' }, 'machine')).toBeNull();
            expect(persistence.read(scope, 'other')).toBeNull();
            storage.set(storageKey, JSON.stringify({ ...snapshot, items: [{ installed: true }] }));
            expect(persistence.read(scope, 'machine')).toBeNull();
        } finally { browser.restore(); }
    });

    it('stores only the cold projection of a full inventory and restores the same presentation', async () => {
        const { browser, storage, persistence } = await storageBoundary();
        try {
            expect(persistence.write(scope, 'machine', fullInventory)).toBe(true);
            const raw = storage.getString(storageKey)!;
            const stored = JSON.parse(raw) as { items: Record<string, unknown>[]; lastCheckedAt: number };
            const fullBytes = new TextEncoder().encode(JSON.stringify(fullInventory)).byteLength;
            const compactBytes = new TextEncoder().encode(raw).byteLength;
            console.info(JSON.stringify({ contract: 'machine-agent-persistence-bytes', agents: fullInventory.items.length,
                machines: 195, fullBytes, compactBytes, projectedAccountBytes: compactBytes * 195 }));
            expect(stored.items).toHaveLength(fullInventory.items.length);
            for (const row of stored.items) expect(Object.keys(row).filter(key => !compactKeys.has(key))).toEqual([]);
            expect(compactBytes).toBeLessThan(fullBytes);
            expect(coldPresentation(persistence.read(scope, 'machine')!)).toEqual(coldPresentation(fullInventory));
        } finally { browser.restore(); }
    });

    it('reads an old full snapshot without writes and rewrites it compact on the next write', async () => {
        const { browser, storage, persistence } = await storageBoundary();
        try {
            const legacy = JSON.stringify(fullInventory);
            storage.set(storageKey, legacy);
            const writes = vi.spyOn(storage, 'set');
            const restored = persistence.read(scope, 'machine')!;
            expect(coldPresentation(restored)).toEqual(coldPresentation(fullInventory));
            expect(writes).not.toHaveBeenCalled();
            expect(storage.getString(storageKey)).toBe(legacy);
            expect(persistence.write(scope, 'machine', restored)).toBe(true);
            const rewritten = JSON.parse(storage.getString(storageKey)!) as { items: Record<string, unknown>[] };
            for (const row of rewritten.items) expect(Object.keys(row).filter(key => !compactKeys.has(key))).toEqual([]);
            expect(coldPresentation(persistence.read(scope, 'machine')!)).toEqual(coldPresentation(fullInventory));
        } finally { browser.restore(); }
    });

    it('settles a quota failure as not persisted without losing the previously saved hints', async () => {
        const { browser, storage, persistence } = await storageBoundary();
        try {
            const previous = { items: [], lastCheckedAt: 1 };
            expect(persistence.write(scope, 'machine', previous)).toBe(true);
            const writes = vi.spyOn(storage, 'set').mockImplementation(() => {
                throw new DOMException('Device storage is full', 'QuotaExceededError');
            });
            expect(persistence.write(scope, 'machine', fullInventory)).toBe(false);
            expect(persistence.read(scope, 'machine')).toEqual(previous);
            writes.mockRestore();
            expect(persistence.write(scope, 'machine', fullInventory)).toBe(true);
        } finally { browser.restore(); }
    });
});
