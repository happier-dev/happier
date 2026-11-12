import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createServer } from 'node:http';
import tweetnacl from 'tweetnacl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginManifestV2Schema } from '@happier-dev/protocol';
import { PluginAvailabilityCollectionWritersClaimActionInputV1Schema } from '@happier-dev/protocol/plugins/availability/actions';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { computePluginUiArtifactSha256DigestV1 } from '@happier-dev/protocol/plugins/ui/artifactIntegrity';
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
import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';
import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from '@/plugins/projection/registry/sources/generatedBundledPluginManifests';
import { BUNDLED_DECLARATION_ASSET_DIR, bundledDeclarationAssetFileName } from '@/plugins/projection/registry/builtIn/declarationAssets';
import { ingestBundledPluginManifest, readBundledPluginManifest } from '@/plugins/projection/registry/builtIn/manifestFile';
import { projectManagedRuntimePublicationManifest } from '@/plugins/projection/registry/builtIn/locators';

describe('release-less declaration installation publisher', () => {
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_ACTIVE_SERVER_ID']);
    const machineId = 'declaration-machine';
    const requests: Array<{ path: string; body: unknown; publisher: string | undefined; authorization: string | undefined }> = [];
    const storedDigests = new Set<string>();
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
        const body = PluginAvailabilityCollectionWritersClaimActionInputV1Schema.parse(JSON.parse(raw));
        if ('manifest' in body) {
            storedDigests.add(computePluginUiArtifactSha256DigestV1(new TextEncoder().encode(createCanonicalJsonSigningInput(body.manifest))));
        } else if (!body.manifestDigestSha256 || !storedDigests.has(body.manifestDigestSha256)) {
            response.statusCode = 404;
            response.end(JSON.stringify({ error: 'plugin_declaration_not_found' }));
            return;
        }
        response.end('{}');
    });
    let home: string;
    let baseUrl: string;

    beforeEach(async () => {
        requests.length = 0;
        storedDigests.clear();
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

    it('claims an admitted bundled summary without decoding its Action schemas and preserves root edits', async () => {
        const locator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find(value => value.pluginId === 'happier.scm.forge.github')!;
        const manifestPath = resolveCliRuntimeAssetPath(locator.manifestRelativePath);
        const full = JSON.parse(readFileSync(manifestPath, 'utf8'));
        const expectedDigest = computePluginUiArtifactSha256DigestV1(new TextEncoder().encode(createCanonicalJsonSigningInput(full)));
        storedDigests.add(expectedDigest);
        const schemaTexts = ['inputSchema', 'resultSchema'].map(key => readFileSync(join(dirname(manifestPath),
            BUNDLED_DECLARATION_ASSET_DIR, bundledDeclarationAssetFileName(basename(manifestPath), key as 'inputSchema' | 'resultSchema')), 'utf8'));
        const admitted = ingestBundledPluginManifest(locator, readBundledPluginManifest(locator));
        if (!admitted.ok) throw new Error('Bundled fixture was not admitted');
        let manifest = admitted.manifest;
        const makeHost = () => createAccountPluginDataStorageHost({ contracts: [],
            readCredentials: async () => ({ token: 'synthetic-declaration-account', encryption: null }),
            isCurrentAccount: () => true, resolveAccountScopeKey: () => 'bundled-summary-account',
            resolveBaseUrl: () => baseUrl, resolveReleaseLessDeclaration: () => manifest });
        const binding = { pluginId: manifest.id, occurrenceId: 'bundled-summary',
            signal: new AbortController().signal, isOccurrenceCurrent: () => true };
        const decode = vi.spyOn(JSON, 'parse');
        try {
            await makeHost().claimReleaseLessDeclaration(binding);
            expect(decode.mock.calls.filter(([input]) => typeof input === 'string' && schemaTexts.includes(input)).length).toBe(0);
        } finally { decode.mockRestore(); }
        expect(requests.map(request => request.body)).toEqual([{ pluginId: manifest.id, manifestDigestSha256: expectedDigest }]);
        manifest = Object.freeze({ ...manifest, displayName: 'Edited bundled declaration' });
        await makeHost().claimReleaseLessDeclaration(binding);
        expect(requests).toHaveLength(3);
        expect(requests[2]!.body).toMatchObject({ manifest: { displayName: 'Edited bundled declaration' } });
        const providerLocator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find(value => value.pluginId === 'happier.provider.cliproxyapi')!;
        const originalProvider = JSON.parse(readFileSync(resolveCliRuntimeAssetPath(providerLocator.manifestRelativePath), 'utf8'));
        storedDigests.add(computePluginUiArtifactSha256DigestV1(new TextEncoder().encode(createCanonicalJsonSigningInput(originalProvider))));
        const projected = ingestBundledPluginManifest(providerLocator, projectManagedRuntimePublicationManifest(
            providerLocator, new Set([providerLocator.pluginId + '\u0000cliproxyapi']), new Set(),
        ));
        if (!projected.ok) throw new Error('Projected bundled fixture was not admitted');
        manifest = projected.manifest;
        await makeHost().claimReleaseLessDeclaration({ ...binding, pluginId: manifest.id });
        expect(requests).toHaveLength(5);
        delete originalProvider.contributes.providers[0].managedRuntime;
        expect(requests[3]!.body).toEqual({ pluginId: manifest.id,
            manifestDigestSha256: computePluginUiArtifactSha256DigestV1(new TextEncoder().encode(createCanonicalJsonSigningInput(originalProvider))) });
        const claimed = requests[4]!.body as { manifest: { contributes: { providers: object[] } } };
        expect(claimed.manifest.contributes.providers[0]).not.toHaveProperty('managedRuntime');
    });

    it('sends zero manifest bytes for the 30-plugin census after an unchanged restart', async () => {
        const manifests = new Map(Array.from({ length: 30 }, (_, index) => {
            const manifest = PluginManifestV2Schema.parse({ schemaVersion: 2, id: 'example.restart-' + index,
                version: '1.0.0', displayName: 'Restart declaration ' + index,
                engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: {} });
            return [manifest.id, manifest] as const;
        }));
        const makeHost = () => createAccountPluginDataStorageHost({ contracts: [],
            readCredentials: async () => ({ token: 'synthetic-declaration-account', encryption: null }),
            isCurrentAccount: () => true, resolveAccountScopeKey: () => 'restart-census-account',
            resolveBaseUrl: () => baseUrl, resolveReleaseLessDeclaration: id => manifests.get(id) ?? null });
        const publish = async (host: ReturnType<typeof makeHost>) => {
            for (const pluginId of manifests.keys()) await host.claimReleaseLessDeclaration({ pluginId,
                occurrenceId: 'restart-census', signal: new AbortController().signal, isOccurrenceCurrent: () => true });
        };
        await publish(makeHost());
        expect(requests.filter(request => Object.hasOwn(request.body as object, 'manifest'))).toHaveLength(30);
        const beforeRestart = requests.length;
        await publish(makeHost());
        const restarted = requests.slice(beforeRestart);
        expect(restarted).toHaveLength(30);
        expect(restarted.filter(request => Object.hasOwn(request.body as object, 'manifest'))).toHaveLength(0);
        // A real declaration edit still reaches the full declaration path once.
        const changed = manifests.values().next().value!;
        manifests.set(changed.id, PluginManifestV2Schema.parse({ ...changed, displayName: 'Edited after restart' }));
        const beforeChange = requests.length;
        await publish(makeHost());
        expect(requests.slice(beforeChange).filter(request => Object.hasOwn(request.body as object, 'manifest'))).toHaveLength(1);
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
        const makeHost = () => createAccountPluginDataStorageHost({
            contracts: [],
            readCredentials: async () => ({ token: 'synthetic-declaration-account', encryption: null }),
            isCurrentAccount: () => true,
            resolveAccountScopeKey: () => 'declaration-test-account',
            resolveBaseUrl: () => baseUrl,
            resolveReleaseLessDeclaration: () => manifest,
        });
        const binding = { pluginId: manifest.id, occurrenceId: 'local-path-occurrence',
            signal: new AbortController().signal, isOccurrenceCurrent: () => true };
        const host = makeHost();
        await host.claimReleaseLessDeclaration(binding);
        await host.claimReleaseLessDeclaration(binding);
        const restartedHost = makeHost();
        const beforeRestart = requests.length;
        await restartedHost.claimReleaseLessDeclaration(binding);
        const restartRequests = requests.slice(beforeRestart);
        expect(restartRequests).toHaveLength(1);
        expect(restartRequests.reduce((bytes, request) => bytes + ('manifest' in (request.body as object) ? JSON.stringify(request.body).length : 0), 0)).toBe(0);
        const initialManifest = manifest;
        manifest = PluginManifestV2Schema.parse({ ...manifest, displayName: 'Edited development declaration' });
        await host.claimReleaseLessDeclaration(binding);

        expect(requests).toHaveLength(5);
        const identity = (value: typeof manifest) => ({ pluginId: value.id,
            manifestDigestSha256: computePluginUiArtifactSha256DigestV1(new TextEncoder().encode(createCanonicalJsonSigningInput(value))) });
        expect(requests.map(request => request.body)).toEqual([
            identity(initialManifest),
            { manifest: JSON.parse(JSON.stringify(initialManifest)) },
            identity(initialManifest),
            identity(manifest),
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
