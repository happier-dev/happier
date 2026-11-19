import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeBase64 } from '@happier-dev/protocol';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { type EnvironmentSecretBindingV1 } from '@happier-dev/deployments/contracts/v1';
import { EnvironmentSecretLaunchAdmissionInputV1Schema } from '@happier-dev/protocol/deployments/environmentSecretLaunchAdmissionV1';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import * as installationStore from '@/daemon/identity/store';
import { sealMachineSecretGrant } from './machineSecretGrant';
import { createManagedDataRoleSecretReaderForHost } from './createManagedDataRoleSecretReaderForHost';

afterEach(() => vi.restoreAllMocks());

describe('managed data-role secret reader', () => {
    const seed = new Uint8Array(32).fill(47);
    const keys = nacl.sign.keyPair.fromSeed(seed);
    const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'owner' })), 'base64url')}.signature`;
    const query = { targetLinkId: 'target-link', expectedRevision: 1 };
    const binding: EnvironmentSecretBindingV1 = { purpose: 'dataRole', targetLinkId: 'target-link', role: 'readOnlyPassword',
        source: { kind: 'secret', ref: formatSharedSavedSecretRefV1('managed-read-role'), resourceRevision: 1 } };

    function install() {
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1, createdAt: 1,
            installationId: 'installation-a', publicKey: encodeBase64(keys.publicKey, 'base64url'), privateKey: encodeBase64(keys.secretKey, 'base64url') });
    }

    function reader(bindings: readonly EnvironmentSecretBindingV1[], access: 'read' | 'write' = 'read') {
        const environment = createDeploymentEnvironmentDetailV1({ content: {
            ...createDeploymentEnvironmentDetailV1().content, bindings: [...bindings],
        } });
        return createManagedDataRoleSecretReaderForHost({ host: { credentials: { token, encryption: null }, serverId: 'home',
            serverHttpBaseUrl: 'https://home.test', machineId: 'machine-a', installationId: 'installation-a' }, environment, query,
            database: 'neondb', context: {}, access });
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

    it('refuses a read invocation requesting write credentials before secret acquisition', async () => {
        install();
        const boundary = vi.spyOn(axios, 'request').mockRejectedValue(new Error('Unexpected write credential acquisition'));
        const readDataRole = reader([binding]);

        await expect(readDataRole({ role: 'write' })).rejects.toMatchObject({ data: { code: 'deployment_access_denied' } });
        expect(boundary).not.toHaveBeenCalled();
    });

    it('opens only the exact selected write binding and keeps read credentials separate', async () => {
        install();
        const write: EnvironmentSecretBindingV1 = { ...binding, role: 'write',
            source: { kind: 'secret', ref: formatSharedSavedSecretRefV1('managed-write-role'), resourceRevision: 1 } };
        const grant = sealMachineSecretGrant({ subject: { v: 1, kind: 'secret', environmentId: 'environment-staging',
            machineId: 'machine-a', installationId: 'installation-a', resourceId: 'managed-write-role', resourceRevision: 1 },
        installationPublicKey: keys.publicKey, content: { kind: 'secret', value: 'postgresql://writer:private@selected/neondb' } });
        const sent: unknown[] = [];
        vi.spyOn(axios, 'request').mockImplementation(async config => {
            const { proof: _proof, ...body } = EnvironmentSecretLaunchAdmissionInputV1Schema.parse(config.data);
            sent.push(body);
            return { status: 200, data: { ok: true, grants: [grant] } };
        });
        const readDataRole = reader([binding, { ...write, targetLinkId: 'neighbor' }, write], 'write');
        await expect(readDataRole({ role: 'write' })).resolves.toBe('postgresql://writer:private@selected/neondb');
        expect(sent).toMatchObject([{ targetLinkId: 'target-link', materialization: {
            kind: 'dataRole', targetLinkId: 'target-link', role: 'write' } }]);
        await expect(reader([binding], 'write')({ role: 'write' })).rejects.toMatchObject({
            code: 'write_connection_setup_required' });
        await expect(reader([write])({ role: 'write' })).rejects.toMatchObject({ code: 'deployment_access_denied' });
        expect(sent).toHaveLength(1);
    });

    it.each(['postgresql://writer:private@selected/neighbor', 'mysql://writer:private@selected/neondb'])(
        'refuses a same-link write URL for a different database or engine (%s)', async value => {
        install();
        const write: EnvironmentSecretBindingV1 = { ...binding, role: 'write' };
        const grant = sealMachineSecretGrant({ subject: { v: 1, kind: 'secret', environmentId: 'environment-staging',
            machineId: 'machine-a', installationId: 'installation-a', resourceId: 'managed-read-role', resourceRevision: 1 },
        installationPublicKey: keys.publicKey, content: { kind: 'secret', value } });
        vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: { ok: true, grants: [grant] } });
        await expect(reader([write], 'write')({ role: 'write' })).rejects.toMatchObject({ code: 'target_mismatch' });
    });
});
