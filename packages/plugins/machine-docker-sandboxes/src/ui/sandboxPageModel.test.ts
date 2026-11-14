import { describe, expect, it } from 'vitest';
import { decodePluginUiManagedMachineInventory } from '@happier-dev/plugin-sdk/ui';

import { readSandboxAvailability, readSandboxCreateRequest, readSandboxPageScope, selectMachineSandboxes } from './sandboxPageModel.js';

type Managed = Parameters<typeof selectMachineSandboxes>[0][number];

const provider = { pluginId: 'happier.machine.docker-sandboxes', localId: 'docker-sandboxes' };
function sandbox(id: string, patch: Partial<Managed> = {}): Managed {
    const snapshot = decodePluginUiManagedMachineInventory(new TextEncoder().encode(JSON.stringify({ machines: [{
        id, homeId: 'home-a', custodianAccountId: 'acct', controller: { machineId: 'shop-prod', installationId: 'inst-1' },
        launch: { provider, schemaVersion: 1, name: `machine-${id}`, choices: { templateId: 'shell', name: id } },
        allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
        resource: { contributionRef: provider, schemaVersion: 1, value: { sandboxName: id } },
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        observation: { observedAt: 1, availability: 'present', power: 'running' },
        ...patch,
    }] })));
    return snapshot.machines[0]!;
}

describe('Docker Sandboxes on one Machine', () => {
    it('retains readable sandboxes and reports controller rows whose private content is unavailable', () => {
        const { launch: _launch, resource: _resource, observation: _observation, ...structural } = sandbox('locked');
        const opaque = { ...structural, preset: { id: 'private-preset', revision: 1, contentEncryptionMode: 'e2ee' as const } };
        expect(selectMachineSandboxes([
            sandbox('readable'), opaque, { ...opaque, id: 'archived', archivedAt: 5 },
            { ...opaque, id: 'canceled', creationState: 'canceled' },
        ], 'shop-prod')).toMatchObject({
            rows: [{ managedId: 'readable', name: 'readable' }], unavailableManagedIds: ['locked'],
        });
        expect(selectMachineSandboxes([opaque], 'another-machine')).toMatchObject({ rows: [], unavailableManagedIds: [] });
    });

    it('lists only this provisioner’s active sandboxes controlled by this Machine', () => {
        const rows = selectMachineSandboxes([
            sandbox('fix-checkout-502'),
            sandbox('elsewhere', { controller: { machineId: 'vps-1', installationId: 'inst-2' } }),
            sandbox('without-controller', { controller: undefined }),
            sandbox('hetzner', {
                launch: { provider: { pluginId: 'happier.machine.hetzner', localId: 'hetzner' }, schemaVersion: 1, name: 'h', choices: {} },
                resource: { contributionRef: { pluginId: 'happier.machine.hetzner', localId: 'hetzner' }, schemaVersion: 1, value: {} },
            }),
            sandbox('retired', { creationState: 'canceled' }),
            sandbox('archived', { archivedAt: 5 }),
        ], 'shop-prod').rows;
        expect(rows.map(row => row.name)).toEqual(['fix-checkout-502']);
        expect(rows[0]).toMatchObject({ managedId: 'fix-checkout-502', templateId: 'shell', state: 'running' });
    });

    it('says only what the native observation proves', () => {
        const rows = selectMachineSandboxes([
            sandbox('a-stopped', { observation: { observedAt: 1, availability: 'present', power: 'stopped' } }),
            sandbox('b-gone', { observation: { observedAt: 1, availability: 'absent' } }),
            sandbox('c-unanswered', { observation: { observedAt: 1, availability: 'unavailable' } }),
            sandbox('d-unconfirmed', { allocation: 'may-exist', resource: undefined, observation: undefined }),
            sandbox('e-running'),
        ], 'shop-prod').rows;
        expect(rows.map(row => [row.name, row.state])).toEqual([
            // Host contract: managedCreationPresentation.ts:59–63; FIXPAR1-BRIEF.md item SB-02.
            // No correlated running acquire proves ongoing creation after an unconfirmed create.
            ['e-running', 'running'], ['d-unconfirmed', 'mayExist'], ['c-unanswered', 'unknown'], ['a-stopped', 'stopped'], ['b-gone', 'gone'],
        ]);
    });

    it('keeps an unsubmitted allocation waiting instead of claiming creation has started', () => {
        // Host contract: managedCreationPresentation.ts:92–96 distinguishes waiting from submitted creation.
        expect(selectMachineSandboxes([
            sandbox('waiting', { allocation: 'unsubmitted', resource: undefined, observation: undefined }),
        ], 'shop-prod').rows).toMatchObject([{ managedId: 'waiting', state: 'waiting' }]);
    });

    it('reads availability from the provisioner check’s own codes', () => {
        expect(readSandboxAvailability({ available: true })).toEqual({ kind: 'ready' });
        expect(readSandboxAvailability({ available: false, code: 'docker_sandbox_unavailable' })).toEqual({ kind: 'notInstalled' });
        // The provider qualifies any installed sbx (CF-NATIVE D1): no version code is a separate presentation here.
        expect(readSandboxAvailability({ available: false, code: 'docker_sandbox_version_unqualified' }))
            .toEqual({ kind: 'unavailable', code: 'docker_sandbox_version_unqualified' });
        expect(readSandboxAvailability({ available: false, code: 'controller_offline' })).toEqual({ kind: 'unavailable', code: 'controller_offline' });
    });

    it('addresses this Machine as a controller only with the host’s Home and installation facts', () => {
        const machine = { kind: 'machine' as const, serverId: 'srv', machineId: 'shop-prod' };
        expect(readSandboxPageScope({ ...machine, homeId: 'home-a', installationId: 'inst-1' }))
            .toEqual({ homeId: 'home-a', controller: { machineId: 'shop-prod', installationId: 'inst-1' } });
        expect(readSandboxPageScope({ ...machine, homeId: 'home-a' })).toBeNull();
        expect(readSandboxPageScope(machine)).toBeNull();
        expect(readSandboxPageScope({ kind: 'app' })).toBeNull();
    });

    it('offers New sandbox only on a host that can open the managed configuration, naming exactly this provisioner', () => {
        expect(readSandboxCreateRequest(['executeAction', 'openSurface'])).toBeNull();
        expect(readSandboxCreateRequest(['executeAction', 'openManagedMachineConfiguration']))
            .toEqual({ provisioner: { pluginId: 'happier.machine.docker-sandboxes', localId: 'docker-sandboxes' } });
    });
});
