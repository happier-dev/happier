import { describe, expect, it } from 'vitest';
import { ManagedAcquireInputV1Schema, isManagedPresetAcquireInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachinePresetV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { bindManagedPresetAcquireOriginV1 } from './presetOrigination';
import { deriveEd25519KeyPair } from '@happier-dev/protocol/crypto/ed25519';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';

describe('fixed-controller preset origination', () => {
    const selection = { kind: 'preset', homeId: 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN', id: 'qa-m-catalog-docker-1111', revision: 0 } as const;
    const retention = { kind: 'until-delete' } as const;
    const controller = { machineId: 'team-controller', installationId: 'installation' };
    const input = ManagedAcquireInputV1Schema.parse({ selection, controller, retention, wakeOnAcceptedMessage: false,
        presetContentOverride: { content: { t: 'encrypted', c: encodeBase64(new Uint8Array(40).fill(1), 'base64') } } });
    const preset = ManagedMachinePresetV1Schema.parse({ id: selection.id, homeId: selection.homeId, revision: 0,
        owner: { kind: 'team', teamId: 'team' }, controller, retention, wakeOnAcceptedMessage: false,
        contentEncryptionMode: 'e2ee', content: { t: 'encrypted', c: encodeBase64(new Uint8Array(40).fill(2), 'base64') }, recipients: [],
        teamAcquireDelegated: true });
    const resolvePool = async () => { throw new Error('Fixed presets never select a pool'); };
    const controllerAccess = { installationPublicKey: encodeBase64(deriveEd25519KeyPair(new Uint8Array(32).fill(17)).publicKey, 'base64url'),
        custodian: { accountId: 'owner' } };
    const resolveExact = async () => ({ kind: 'resolved', controller, controllerAccess });

    it('retains the exact fixed structural controller without opening or generating private review facts', async () => {
        await expect(bindManagedPresetAcquireOriginV1({ input, preset, requestKey: 'request', resolvePool, resolveExact }))
            .resolves.toEqual({ kind: 'bound', input, controllerAccess });
    });

    it('binds pool placement and its access carrier without generating private facts', async () => {
        const poolId = '24dc99d8-4809-4ce8-aedb-c9eca0def049';
        const pooled = ManagedMachinePresetV1Schema.parse({ ...preset, controller: undefined, controllerPoolId: poolId });
        const unbound = ManagedAcquireInputV1Schema.parse({ ...input, controller: undefined });
        const placement = { kind: 'resolved', poolId, machineId: controller.machineId, priorityTier: 0,
            managedPreset: { preset: { id: preset.id, revision: preset.revision, contentEncryptionMode: 'e2ee' }, controller, controllerAccess: { installationPublicKey: encodeBase64(deriveEd25519KeyPair(new Uint8Array(32).fill(17)).publicKey, 'base64url'),
                custodian: { accountId: 'owner' } } } };
        await expect(bindManagedPresetAcquireOriginV1({ input: unbound, preset: pooled, requestKey: 'pool',
            resolvePool: async () => placement, resolveExact })).resolves.toEqual({ kind: 'bound', controllerAccess: placement.managedPreset.controllerAccess,
                input: { ...unbound, controller } });
    });

    it('refuses an explicitly different controller instead of redirecting admitted work', async () => {
        const bound = ManagedAcquireInputV1Schema.parse({ ...input, controller: { ...controller, machineId: 'different' } });
        await expect(bindManagedPresetAcquireOriginV1({ input: bound, preset, requestKey: 'request', resolvePool, resolveExact }))
            .resolves.toEqual({ kind: 'refused', code: 'controller_retired' });
    });

    it('binds an unaddressed exact acquire to its saved controller before encrypting', async () => {
        const unbound = ManagedAcquireInputV1Schema.parse({ ...input, controller: undefined });
        await expect(bindManagedPresetAcquireOriginV1({ input: unbound, preset, requestKey: 'unbound', resolvePool, resolveExact }))
            .resolves.toEqual({ kind: 'bound', input, controllerAccess });
    });

    it('carries an omitted opaque preset policy unchanged to native qualification', async () => {
        if (!isManagedPresetAcquireInputV1(input)) throw new Error('Expected opaque preset acquire input');
        const { retention: _retention, wakeOnAcceptedMessage: _wake, ...withoutPolicy } = input;
        const unspecified = ManagedMachinePresetV1Schema.parse({ ...preset, retention: undefined, wakeOnAcceptedMessage: undefined });
        await expect(bindManagedPresetAcquireOriginV1({ input: withoutPolicy, preset: unspecified,
            requestKey: 'native-policy', resolvePool, resolveExact }))
            .resolves.toEqual({ kind: 'bound', input: withoutPolicy, controllerAccess });
    });

    it('retains native-reviewed policy when the preset leaves its public policy unspecified', async () => {
        const unspecified = ManagedMachinePresetV1Schema.parse({ ...preset, retention: undefined, wakeOnAcceptedMessage: undefined });
        await expect(bindManagedPresetAcquireOriginV1({ input, preset: unspecified, requestKey: 'unspecified', resolvePool, resolveExact }))
            .resolves.toEqual({ kind: 'bound', input, controllerAccess });
    });

    it('refuses a retention change instead of widening the saved public acquisition policy', async () => {
        const changed = ManagedAcquireInputV1Schema.parse({ ...input, retention: { kind: 'unused', afterMs: 60_000, effect: 'delete' } });
        await expect(bindManagedPresetAcquireOriginV1({ input: changed, preset, requestKey: 'changed', resolvePool, resolveExact }))
            .resolves.toEqual({ kind: 'refused', code: 'permission_denied' });
    });
});
