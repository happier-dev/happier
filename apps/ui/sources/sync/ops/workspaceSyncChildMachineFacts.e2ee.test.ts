import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveWorkspaceSyncTransportAddress } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import { managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import type { ManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

const { readUiWorkspaceSyncChildMachineFacts } = await import('./workspaceSyncChildMachineFacts');
const { captureLazyActionAccountContext } = await import('./actions/actionAccountContext');

beforeEach(async () => {
    await harness.reset();
});
afterEach(async () => {
    standardCleanup();
    await harness.reset();
});

describe('workspace Sync E2EE managed child facts', () => {
    it('opens the exact opaque managed snapshot before resolving its Devcontainer child topology', async () => {
        const credentials = {
            token: createAccountTokenForTests('owner', { currentAccount: true }),
            secret: encodeBase64(new Uint8Array(32).fill(71), 'base64url'),
        };
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        const serverId = await harness.addHome({
            name: 'E2EE Devcontainer child', serverUrl: 'https://e2ee-devcontainer-child.example',
            accountId: 'owner', currentAccount: true, accountEncryptionMode: 'e2ee', credentials,
        });
        const controller = { machineId: 'parent', installationId: 'parent-installation' } as const;
        const launch = {
            provider: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1,
            name: 'Private Devcontainer child', choices: {},
        } as const;
        const observation = {
            nativeResourceId: 'private-native-child', user: 'developer', workspaceFolder: '/work/child',
            storage: { kind: 'bind' as const, hostPath: '/work/parent', childPath: '/work/child' },
        };
        const resource = {
            contributionRef: launch.provider, schemaVersion: launch.schemaVersion, value: {},
            devcontainerObservation: observation,
        };
        const { sealManagedMachinePresetContentV1, replaceManagedMachinePresetLaunchNameV1,
            projectManagedMachinePresetForRecipientV1 } = await import(
            '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1'
        );
        const recipient = {
            account: { kind: 'account' as const, accountId: 'owner', name: null, firstName: 'Owner', lastName: null, username: 'owner', avatarUrl: null },
            readiness: { status: 'available' as const, contentPublicKey: encodeBase64(encryption.contentDataKey, 'base64'),
                contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(encryption.contentDataKey) },
            envelopeStatus: 'missing' as const,
        };
        const sealed = sealManagedMachinePresetContentV1({
            presetId: 'devcontainer-preset', mode: 'e2ee', content: { v: 1, name: 'Private preset', launch },
            recipientCensus: [recipient], randomBytes: length => new Uint8Array(length).fill(17),
        });
        const reviewedFacts = {
            launch, controller, optionStatus: 'current' as const,
            billing: { location: 'local' as const, stoppedBilling: 'not-billed' as const }, prerequisites: [],
            retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] },
            retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false,
        } satisfies ManagedConfigurationFactsV1;
        const snapshot = replaceManagedMachinePresetLaunchNameV1({
            presetId: 'devcontainer-preset', mode: 'e2ee', content: sealed.content, recipients: sealed.recipients,
            accountId: 'owner', accountKey: encryption.getContentPrivateKey(), launchName: launch.name,
            reviewedFacts, nativeResult: { kind: 'bound', resource }, randomBytes: length => new Uint8Array(length).fill(23),
        });
        expect(snapshot).not.toBeNull();
        if (!snapshot) throw new Error('Expected E2EE managed snapshot');

        const projection = {
            relation: { managedMachineId: 'managed-child', managedMachineKind: 'devcontainer' as const, parentMachineId: controller.machineId },
            observation,
        };
        const read = {
            machine: {
                id: 'managed-child', homeId: serverId, custodianAccountId: 'owner',
                preset: { id: 'devcontainer-preset', revision: 1, contentEncryptionMode: 'e2ee' as const }, controller,
                allocation: 'bound' as const, creationState: 'active' as const, enrolledMachineId: 'child',
                desired: 'start' as const, desiredWhen: 'now' as const, intentRevision: 1,
                retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false,
            },
            presetContent: projectManagedMachinePresetForRecipientV1({
                content: snapshot, recipients: sealed.recipients, recipientAccountId: 'owner',
            }),
        };
        harness.answer(serverId, '/v1/machines?includeRevoked=true', { body: [{
            id: 'child', installationId: 'child-installation', devcontainerChild: projection,
            revokedAt: null, replacedByMachineId: null,
        }] });
        harness.answer(serverId, managedMachineActionEndpointPathV1('machines.managed.get'), { body: read });

        const account = await captureLazyActionAccountContext(serverId);
        try {
            const census = await readUiWorkspaceSyncChildMachineFacts(account);
            const [fact] = await census.readChildMachines(['child']);
            expect(fact?.managedMachine).toMatchObject({ resource });
            expect(harness.requestsFor(managedMachineActionEndpointPathV1('machines.managed.get'))).toHaveLength(1);
            expect(harness.requests.filter(request => request.path.startsWith('/v1/machines/presets/'))).toEqual([]);
            expect(resolveWorkspaceSyncTransportAddress({
                namespace: { serverId, machineId: 'child', rootPath: '/work/child' },
                childMachines: fact ? [fact] : [],
            })).toEqual({ ok: true, address: { machineId: 'parent', installationId: 'parent-installation' } });
        } finally {
            account.dispose();
        }
    });
});
