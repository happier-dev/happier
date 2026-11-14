import { describe, expect, it } from 'vitest';
import { hydrateManagedOpaquePresetMachineV1 } from '@happier-dev/cli-common/machines/managed';
import { ManagedMachineV1Schema, ManagedOpaquePresetMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedMachinePresetContentV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';

import { decodePluginUiManagedMachineInventory } from './managedMachineInventory.js';

describe('managed inventory host read', () => {
    it('reads custody-hydrated E2EE rows and unavailable structural rows without changing the public wire contract', () => {
        const machine = ManagedOpaquePresetMachineV1Schema.parse({
            id: 'sandbox', homeId: 'home', custodianAccountId: 'owner',
            preset: { id: 'preset', revision: 1, contentEncryptionMode: 'e2ee' },
            controller: { machineId: 'controller', installationId: 'installation' },
            allocation: 'unsubmitted', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        });
        const opened = ManagedMachinePresetContentV1Schema.parse({ v: 1, name: 'Sandbox', launch: {
            provider: { pluginId: 'happier.machine.docker-sandboxes', localId: 'docker-sandboxes' },
            schemaVersion: 1, name: 'Sandbox', choices: { name: 'private-name' },
        } });
        const hydrated = hydrateManagedOpaquePresetMachineV1({ machine, opened });
        expect(hydrated).not.toBeNull();
        expect(ManagedMachineV1Schema.safeParse(hydrated).success).toBe(false);
        const bytes = new TextEncoder().encode(JSON.stringify({ machines: [hydrated, { ...machine, id: 'locked' }] }));
        const decoded = decodePluginUiManagedMachineInventory(bytes);
        expect(decoded.machines).toEqual([hydrated, { ...machine, id: 'locked' }]);
        expect(decoded.machines[0]?.launch?.choices).toEqual({ name: 'private-name' });
        expect(decoded.machines[1]?.launch).toBeUndefined();
    });

    it('rejects a raw opaque Action wrapper rather than pretending it is the hydrated host projection', () => {
        const bytes = new TextEncoder().encode(JSON.stringify({ machines: [{ machine: { id: 'sandbox' }, presetContent: {} }] }));
        expect(() => decodePluginUiManagedMachineInventory(bytes)).toThrow();
    });
});
