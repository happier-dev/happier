import { describe, expect, it } from 'vitest';
import { ManagedAcquireInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachinePresetV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { MachineProvisionerContributionV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { buildManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { PluginJsonValueV2Schema } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { bindManagedPresetAcquireOriginV1 } from './presetOrigination';
import { deriveEd25519KeyPair } from '@happier-dev/protocol/crypto/ed25519';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';

describe('fixed-controller preset origination', () => {
    const selection = { kind: 'preset', homeId: 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN', id: 'qa-m-catalog-docker-1111', revision: 0 } as const;
    const retention = { kind: 'until-delete' } as const;
    const input = ManagedAcquireInputV1Schema.parse({
        selection,
        enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' },
        retention, wakeOnAcceptedMessage: false,
    });
    const controller = { machineId: 'team-controller', installationId: 'installation' };
    const provisioner = MachineProvisionerContributionV1Schema.parse({ id: 'docker', title: 'Docker', icon: 'server', resourceKind: 'container', schemaVersion: 1,
        enrollmentRole: 'sandbox', launchSchema: { type: 'object', properties: {}, additionalProperties: false },
        resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'], prerequisites: [],
        billing: { location: 'local', stoppedBilling: 'not-billed' }, retention: { supportedIntents: ['delete'] },
        actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy' } });
    const launch = { provider: { pluginId: 'fixture.docker', localId: 'docker' }, schemaVersion: 1, name: 'Docker', choices: {} };
    const reviewedFacts = buildManagedConfigurationFactsV1({ choicesSchema: PluginJsonValueV2Schema, launch, controller,
        optionStatus: 'current', prerequisites: [], billing: provisioner.billing, retentionCapabilities: provisioner.retention,
        preset: { id: selection.id, revision: selection.revision, retention } });
    const preset = ManagedMachinePresetV1Schema.parse({ id: selection.id, homeId: selection.homeId, revision: 0, name: 'Docker',
        owner: { kind: 'team', teamId: 'team' }, launch, controller, retention, teamAcquireDelegated: true,
        delegatedAcquire: { kind: 'ready', provisioner, reviewedFacts } });
    const resolvePool = async () => { throw new Error('Fixed presets never select a pool'); };

    it('binds the saved controller and delegated facts without requiring a controller grant or caller-supplied facts', async () => {
        await expect(bindManagedPresetAcquireOriginV1({ input, preset, requestKey: 'request', resolvePool }))
            .resolves.toMatchObject({ kind: 'bound', input: { ...input, controller, reviewedFacts } });
    });

    it('projects the requested Machine name into generated facts without mutating the reusable preset', async () => {
        const named = ManagedAcquireInputV1Schema.parse({ ...input, selection: { ...selection, name: 'Member guest' } });
        await expect(bindManagedPresetAcquireOriginV1({ input: named, preset, requestKey: 'named', resolvePool }))
            .resolves.toMatchObject({ kind: 'bound', input: { selection: { name: 'Member guest' },
                reviewedFacts: { launch: { name: 'Member guest' } } } });
        expect(preset.delegatedAcquire).toMatchObject({ reviewedFacts: { launch: { name: 'Docker' } } });
    });

    it('projects the requested name after pool placement without changing the selected facts', async () => {
        const poolId = '24dc99d8-4809-4ce8-aedb-c9eca0def049';
        const pooled = ManagedMachinePresetV1Schema.parse({ ...preset, controller: undefined, controllerPoolId: poolId });
        const named = ManagedAcquireInputV1Schema.parse({ ...input, selection: { ...selection, name: 'Pool guest' } });
        const placement = { kind: 'resolved', poolId, machineId: controller.machineId, priorityTier: 0,
            managedPreset: { controller, controllerAccess: { installationPublicKey: encodeBase64(deriveEd25519KeyPair(new Uint8Array(32).fill(17)).publicKey, 'base64url'),
                custodian: { accountId: 'owner' } }, provisioner, reviewedFacts } };
        await expect(bindManagedPresetAcquireOriginV1({ input: named, preset: pooled, requestKey: 'named-pool',
            resolvePool: async () => placement })).resolves.toMatchObject({ kind: 'bound', input: {
                controller, reviewedFacts: { launch: { name: 'Pool guest' } } } });
        expect(placement.managedPreset.reviewedFacts.launch.name).toBe('Docker');
    });

    it('refuses an explicitly different controller instead of redirecting admitted work', async () => {
        const bound = ManagedAcquireInputV1Schema.parse({ ...input, controller: { ...controller, machineId: 'different' } });
        await expect(bindManagedPresetAcquireOriginV1({ input: bound, preset, requestKey: 'request', resolvePool }))
            .resolves.toEqual({ kind: 'refused', code: 'controller_retired' });
    });

    it('retains caller-reviewed facts for Account admission rather than silently replacing an effect review', async () => {
        const explicitFacts = { ...reviewedFacts, reviewedEffectDigest: 'a'.repeat(64) };
        const reviewed = ManagedAcquireInputV1Schema.parse({ ...input, controller, reviewedFacts: explicitFacts });
        await expect(bindManagedPresetAcquireOriginV1({ input: reviewed, preset, requestKey: 'request', resolvePool }))
            .resolves.toMatchObject({ kind: 'bound', input: { reviewedFacts: explicitFacts } });
    });
});
