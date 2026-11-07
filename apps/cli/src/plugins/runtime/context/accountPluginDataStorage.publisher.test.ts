import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import tweetnacl from 'tweetnacl';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginManifestV2Schema } from '@happier-dev/protocol';
import {
    PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
    PluginInstallationManifestPublisherHeaderV1Schema,
    createPluginInstallationManifestPublisherSigningInputV1,
    stringifyPluginInstallationManifestCanonicalJsonV1,
} from '@happier-dev/protocol/plugins/installations/manifests';

import { configuration, reloadConfiguration } from '@/configuration';
import { readCurrentMachineInstallation } from '@/daemon/identity/currentMachineInstallation';
import { writeSettings } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createAccountPluginDataStorageHost } from './accountPluginDataStorage';

describe('release-less declaration installation publisher', () => {
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_ACTIVE_SERVER_ID']);
    const machineId = 'declaration-machine';
    const requests: Array<{ path: string; body: unknown; publisher: string | undefined; authorization: string | undefined }> = [];
    const server = createServer(async (request, response) => {
        let raw = '';
        for await (const chunk of request) raw += String(chunk);
        requests.push({
            path: request.url ?? '',
            body: JSON.parse(raw),
            publisher: request.headers[PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1] as string | undefined,
            authorization: request.headers.authorization,
        });
        response.setHeader('content-type', 'application/json');
        response.end('{}');
    });
    let home: string;
    let baseUrl: string;

    beforeEach(async () => {
        requests.length = 0;
        home = await createTempDir('happier-declaration-publisher-');
        env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: 'https://declaration-home.invalid',
            HAPPIER_LOCAL_SERVER_URL: '', HAPPIER_ACTIVE_SERVER_ID: '' });
        reloadConfiguration();
        await writeSettings({ schemaVersion: 6, onboardingCompleted: true,
            machineIdByServerId: { [configuration.activeServerId]: machineId } });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing declaration test listener');
        baseUrl = `http://127.0.0.1:${address.port}`;
    });

    afterEach(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        env.restore();
        reloadConfiguration();
        await removeTempDir(home);
    });

    it('authenticates real claim HTTP bodies with the persisted installation and republishes same-version edits', async () => {
        let manifest = PluginManifestV2Schema.parse({
            schemaVersion: 2,
            id: 'example.declaration-publisher',
            version: '0.0.0',
            displayName: 'Development declaration',
            engines: { happier: '^1.0.0' },
            runtime: { apiVersion: 1 },
            contributes: {},
        });
        const host = createAccountPluginDataStorageHost({
            contracts: [],
            readCredentials: async () => ({ token: 'synthetic-declaration-account', encryption: null }),
            isCurrentAccount: () => true,
            resolveAccountScopeKey: () => 'declaration-test-account',
            resolveBaseUrl: () => baseUrl,
            resolveReleaseLessDeclaration: () => manifest,
        });
        const binding = { pluginId: manifest.id, occurrenceId: 'local-path-occurrence',
            signal: new AbortController().signal, isOccurrenceCurrent: () => true };
        await host.claimReleaseLessDeclaration(binding);
        await host.claimReleaseLessDeclaration(binding);
        const initialManifest = manifest;
        manifest = PluginManifestV2Schema.parse({ ...manifest, displayName: 'Edited development declaration' });
        await host.claimReleaseLessDeclaration(binding);

        expect(requests).toHaveLength(2);
        expect(requests.map(request => request.body)).toEqual([
            { manifest: JSON.parse(JSON.stringify(initialManifest)) },
            { manifest: JSON.parse(JSON.stringify(manifest)) },
        ]);
        const installation = await readCurrentMachineInstallation();
        if (!installation) throw new Error('Missing isolated publisher installation');
        for (const request of requests) {
            expect(request.path).toBe('/v1/plugins/availability/collection-writers/claim');
            expect(request.authorization).toBe('Bearer synthetic-declaration-account');
            expect(request.publisher).toEqual(expect.any(String));
            const { proof } = PluginInstallationManifestPublisherHeaderV1Schema.parse(
                JSON.parse(Buffer.from(request.publisher ?? '', 'base64url').toString('utf8')),
            );
            expect(proof).toMatchObject({ method: 'POST', path: request.path, machineId,
                installationId: installation.identity.installationId,
                bodySha256Base64Url: createHash('sha256')
                    .update(stringifyPluginInstallationManifestCanonicalJsonV1(request.body)).digest('base64url') });
            const { signatureBase64Url, ...signedProof } = proof;
            expect(tweetnacl.sign.detached.verify(
                createPluginInstallationManifestPublisherSigningInputV1({ proof: signedProof }),
                Buffer.from(signatureBase64Url, 'base64url'),
                Buffer.from(installation.identity.publicKey, 'base64url'),
            )).toBe(true);
        }
    });
});
