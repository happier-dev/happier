import { z } from 'zod/mini';
import { MachineAgentInventoryItemSchema } from '@happier-dev/protocol/capabilities';
import { serverAccountScopedStorageKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

const SnapshotSchema = z.strictObject({ items: z.array(MachineAgentInventoryItemSchema), lastCheckedAt: z.number().check(z.nonnegative()) });
export type PersistedMachineAgentInventory = z.infer<typeof SnapshotSchema>;
export type MachineAgentInventoryStorage = Readonly<{ getString(key: string): string | undefined; set(key: string, value: string): void }>;

// Cold rows also feed Agent detail and Updates. Retain their small display/state inputs,
// never installer details or complete dependency/probe objects. Construct only on an actual read.
const CompactItemSchema = z.lazy(() => {
    const fields = MachineAgentInventoryItemSchema.shape;
    return z.strictObject({
        agentId: fields.agentId, definitionId: fields.definitionId, title: fields.title,
        installed: fields.installed, managed: fields.managed, version: fields.version, latestVersion: fields.latestVersion,
        updateSupported: fields.update.shape.supported, updateCommand: fields.update.shape.command,
        signInStatus: fields.signIn.shape.status, signInRequired: fields.signIn.shape.required,
        loginSupport: fields.signIn.shape.loginSupport, accountLabel: fields.signIn.shape.accountLabel,
        platform: fields.platform, fit: fields.fit, executionScope: fields.install.shape.executionScope,
        missingDependencies: z.array(z.string().check(z.minLength(1))),
    });
});
const CompactSnapshotSchema = z.strictObject({ items: z.array(CompactItemSchema), lastCheckedAt: SnapshotSchema.shape.lastCheckedAt });
type CompactSnapshot = z.infer<typeof CompactSnapshotSchema>;

function compact(snapshot: PersistedMachineAgentInventory): CompactSnapshot {
    return { lastCheckedAt: snapshot.lastCheckedAt, items: snapshot.items.map(item => ({
        agentId: item.agentId, title: item.title,
        ...(item.definitionId === undefined ? {} : { definitionId: item.definitionId }),
        installed: item.installed, ...(item.managed === undefined ? {} : { managed: item.managed }),
        version: item.version, latestVersion: item.latestVersion,
        updateSupported: item.update.supported, updateCommand: item.update.command,
        signInStatus: item.signIn.status, loginSupport: item.signIn.loginSupport,
        ...(item.signIn.required === undefined ? {} : { signInRequired: item.signIn.required }),
        ...(item.signIn.accountLabel === undefined ? {} : { accountLabel: item.signIn.accountLabel }),
        platform: item.platform, ...(item.fit === undefined ? {} : { fit: item.fit }),
        ...(item.install.executionScope === undefined ? {} : { executionScope: item.install.executionScope }),
        missingDependencies: item.dependencies.filter(dependency => !dependency.installed).map(dependency => dependency.key),
    })) };
}

/** Feed the existing cold/stale inventory owner; omitted installer data cannot enable an action. */
function expand(snapshot: CompactSnapshot): PersistedMachineAgentInventory {
    return { lastCheckedAt: snapshot.lastCheckedAt, items: snapshot.items.map(item => ({
        agentId: item.agentId, title: item.title,
        ...(item.definitionId === undefined ? {} : { definitionId: item.definitionId }),
        installed: item.installed, ...(item.managed === undefined ? {} : { managed: item.managed }),
        version: item.version, latestVersion: item.latestVersion,
        update: { supported: item.updateSupported, command: item.updateCommand },
        signIn: { status: item.signInStatus, loginSupport: item.loginSupport,
            ...(item.signInRequired === undefined ? {} : { required: item.signInRequired }),
            ...(item.accountLabel === undefined ? {} : { accountLabel: item.accountLabel }) },
        platform: item.platform, ...(item.fit === undefined ? {} : { fit: item.fit }),
        install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null,
            ...(item.executionScope === undefined ? {} : { executionScope: item.executionScope }) },
        dependencies: item.missingDependencies.map(key => ({ key, installed: false, version: null })),
    })) };
}

export function createMachineAgentInventoryPersistence(storage: MachineAgentInventoryStorage) {
    const key = (scope: ServerAccountScope, machineId: string) => serverAccountScopedStorageKey(`machine-agents:v1:${JSON.stringify(machineId)}`, scope);
    return {
        read(scope: ServerAccountScope, machineId: string): PersistedMachineAgentInventory | null {
            const raw = storage.getString(key(scope, machineId));
            if (!raw) return null;
            try {
                const value: unknown = JSON.parse(raw);
                const projected = CompactSnapshotSchema.safeParse(value);
                if (projected.success) return expand(projected.data);
                const legacy = SnapshotSchema.safeParse(value);
                return legacy.success ? expand(compact(legacy.data)) : null;
            } catch { return null; }
        },
        write(scope: ServerAccountScope, machineId: string, snapshot: PersistedMachineAgentInventory): boolean {
            try {
                storage.set(key(scope, machineId), JSON.stringify(compact(snapshot)));
                return true;
            } catch {
                // Last-known device hints are optional; a storage failure must not withdraw live inventory.
                return false;
            }
        },
    };
}
