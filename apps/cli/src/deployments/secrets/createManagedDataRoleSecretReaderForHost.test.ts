import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeBase64 } from '@happier-dev/protocol';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { DeploymentTargetDataQueryInputV1Schema } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';
import { EnvironmentSecretLaunchAdmissionInputV1Schema, type EnvironmentSecretBindingV1 } from '@happier-dev/deployment-protocol';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import * as installationStore from '@/daemon/identity/store';
import { sealMachineSecretGrant } from './machineSecretGrant';
import { createManagedDataRoleSecretReaderForHost } from './createManagedDataRoleSecretReaderForHost';

afterEach(() => vi.restoreAllMocks());

describe('managed data-role secret reader', () => {
    const seed = new Uint8Array(32).fill(47);
    const keys = nacl.sign.keyPair.fromSeed(seed);
    const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'owner' })), 'base64url')}.signature`;
    const credentialRef = { service: { pluginId: 'happier.deploy.neon', localId: 'neon' }, accountId: 'connected' };
    const query = DeploymentTargetDataQueryInputV1Schema.parse({ v: 1, serverId: 'home', environmentId: 'environment-staging',
        expectedRevision: 1, targetLinkId: 'target-link', expectedTargetLinkRevision: 1, credentialRef,
        credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: {
            consumer: { pluginId: 'happier.deploy.neon', localId: 'query-read' }, purpose: 'deploy-manage',
        }, target: { kind: 'account', account: credentialRef } },
        providerIdentity: { providerAccountId: 'org', providerResourceId: 'project', providerEnvironment: 'branch' },
        providerEnvironment: { kind: 'custom', id: 'branch' }, database: 'neondb', sql: 'SELECT 1', params: {} });
    const binding: EnvironmentSecretBindingV1 = { purpose: 'dataRole', targetLinkId: 'target-link', role: 'readOnlyPassword',
        source: { kind: 'secret', ref: formatSharedSavedSecretRefV1('managed-read-role'), resourceRevision: 1 } };

    function install() {
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1, createdAt: 1,
            installationId: 'installation-a', publicKey: encodeBase64(keys.publicKey, 'base64url'), privateKey: encodeBase64(keys.secretKey, 'base64url') });
    }

    function reader(bindings: readonly EnvironmentSecretBindingV1[]) {
        const environment = createDeploymentEnvironmentDetailV1({ content: {
            ...createDeploymentEnvironmentDetailV1().content, bindings: [...bindings],
        } });
        return createManagedDataRoleSecretReaderForHost({ host: { credentials: { token, encryption: null }, serverId: 'home',
            serverHttpBaseUrl: 'https://home.test', machineId: 'machine-a', installationId: 'installation-a' }, environment, query, context: {} });
    }

    it('lazily opens only the admitted managed-link binding through P42', async () => {
        install();
        const grant = sealMachineSecretGrant({ subject: { v: 1, kind: 'secret', environmentId: 'environment-staging',
            machineId: 'machine-a', installationId: 'installation-a', resourceId: 'managed-read-role', resourceRevision: 1 },
        installationPublicKey: keys.publicKey, content: { kind: 'secret', value: 'managed-read-role-password' } });
        const sent: unknown[] = [];
        const boundary = vi.spyOn(axios, 'request').mockImplementation(async config => {
            const { proof: _proof, ...body } = EnvironmentSecretLaunchAdmissionInputV1Schema.parse(config.data);
            sent.push(body);
            return { status: 200, data: { ok: true, grants: [grant] } };
        });
        const readDataRole = reader([binding]);

        expect(boundary).not.toHaveBeenCalled();
        await expect(readDataRole()).resolves.toBe('managed-read-role-password');
        expect(sent).toEqual([{ serverId: 'home', environmentId: 'environment-staging', targetLinkId: 'target-link',
            machineId: 'machine-a', installationId: 'installation-a',
            materialization: { kind: 'dataRole', expectedRevision: 1, targetLinkId: 'target-link' } }]);
    });

    it('fails closed only when an invoked query has no exact managed binding', async () => {
        install();
        const boundary = vi.spyOn(axios, 'request');
        const readDataRole = reader([{ ...binding, targetLinkId: 'other-managed-link' }]);

        await expect(readDataRole()).rejects.toMatchObject({ data: { code: 'secret_missing' } });
        expect(boundary).not.toHaveBeenCalled();
    });
});
