import fastify from 'fastify';
import * as fs from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityCollectionWritersClaimActionInputV1Schema,
    PluginAvailabilityCollectionWritersClaimActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability';
import { PLUGIN_COLLECTION_QUERY_HTTP_PATH_V1, PluginCollectionQueryRequestV1Schema } from '@happier-dev/protocol/plugins/data/collectionsV1';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { registerAuthoredAccountActionRelease } from '@/plugins/runtime/accountPluginActions.testkit';
import { createHttpCollectionBoundary } from '@/plugins/runtime/context/accountPluginDataStorage.testkit';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';
import { registerAccountHomeHttp } from './widgetApproval.testkit';
import { PLUGIN_MANIFEST } from '../../../../../packages/plugins/triage/src/manifest';
import { CORPUS_SESSION_LINKS_COLLECTION, CORPUS_SOURCE_INSTANCES_COLLECTION } from '../../../../../packages/plugins/triage/src/corpus/collections/definitions';
import { sourceBuildNodeArgs } from '../../../../../apps/stack/scripts/utils/proc/runSourceBuildCommand.mjs';

const repoRoot = resolve(import.meta.dirname, '../../../../..');
const manifestAsset = 'apps/cli/assets/bundled-plugin-manifests/triage.json';
let projectionRoot: string;
let freshManifest: string;
beforeAll(async () => {
    projectionRoot = await mkdtemp(join(tmpdir(), 'triage-cli-projections-'));
    await promisify(execFile)(process.execPath, sourceBuildNodeArgs({ repoDir: repoRoot,
        scriptPath: join(repoRoot, 'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts'),
        args: ['--daemon-projections', '--daemon-output-root', projectionRoot],
    }), { cwd: repoRoot });
    freshManifest = await readFile(join(projectionRoot, manifestAsset), 'utf8');
}, 240_000); // Existing composed-lane allowance: invokes the real all-plugin publisher.
afterAll(async () => {
    if (projectionRoot) await rm(projectionRoot, { recursive: true, force: true });
});

it.each(['portable', 'bundled'] as const)('reads Triage Session relationships through the credentialed CLI and %s Account registration', async source => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'triage-cli-links-'));
    const readFileSync = fs.readFileSync;
    // Filesystem is the boundary: source daemon construction resolves these
    // exact assets from its private generated projectionRoot, not checkout assets.
    const projectionRead = vi.spyOn(fs, 'readFileSync').mockImplementation((path, ...options) => {
        if (String(path) === join(repoRoot, manifestAsset)) return freshManifest;
        return readFileSync(path, ...options);
    });
    const app = fastify();
    const paths: string[] = [];
    app.addHook('onRequest', async request => { paths.push(request.url.split('?')[0]!); });
    const accountId = 'triage-cli-owner';
    const serverId = 'triage-cli-home';
    const serverApiUrl = 'http://triage-cli.test';
    const sessionId = 'c111111111111111111111111';
    const features = registerAccountHomeHttp(app, { accountId, serverId });
    app.get(`/v2/sessions/${sessionId}`, async () => ({ session: {
        ...createSessionNotificationContextFixture(sessionId), encryptionMode: 'plain',
        metadata: JSON.stringify({ path: happyHomeDir }),
    } }));
    app.get('/v1/tasks', async () => ({ tasks: [] }));
    app.get('/v1/kv', async () => ({ items: [] }));
    const release = await registerAuthoredAccountActionRelease(app, accountId, { primary: {
        manifest: PLUGIN_MANIFEST,
        projectRoot: resolve(import.meta.dirname, '../../../../../packages/plugins/triage'),
        entryPath: resolve(import.meta.dirname, '../../../../../packages/plugins/triage/src/accountRuntime.ts'),
        artifactId: 'triage-account-runtime', activateExport: 'activate', manifestExport: null,
    } });
    if (source !== 'portable') release.setBundledFallback();
    // Home HTTP persistence is the system boundary; the real Collection host
    // retains schema admission, mode checks, index encoding and row decoding.
    const collections = new Map([
        CORPUS_SESSION_LINKS_COLLECTION, CORPUS_SOURCE_INSTANCES_COLLECTION,
    ].map(definition => [definition.id, createHttpCollectionBoundary(definition.indexes, 'plain')]));
    const reads: string[] = [];
    app.post(PLUGIN_COLLECTION_QUERY_HTTP_PATH_V1, async request => {
        const body = PluginCollectionQueryRequestV1Schema.parse(request.body);
        const collection = collections.get(body.collectionId);
        if (!collection) throw new Error('Unexpected Triage Collection');
        reads.push(body.collectionId);
        return (await collection.http.post(`${serverApiUrl}${PLUGIN_COLLECTION_QUERY_HTTP_PATH_V1}`, JSON.stringify(request.body))).data;
    });
    let writerClaimed = false;
    app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.collectionWriters.claim'], async request => {
        const { manifest } = PluginAvailabilityCollectionWritersClaimActionInputV1Schema.parse(request.body);
        writerClaimed = true;
        return PluginAvailabilityCollectionWritersClaimActionOutputV1Schema.parse({ intent: {
            pluginId: manifest.id, desiredVersion: null, enabled: true, offlineUiHosting: 'disabled',
            revision: '1', writableCollections: [],
        } });
    });
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin: serverApiUrl });
    try {
        const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
        const credentials = { token, encryption: null, credentialProvenance: 'stored_session' } as const;
        const executor = createCliActionExecutorFromCredentials({ credentials, readCredentials: async () => credentials,
            happyHomeDir, serverId, serverApiUrl, serverIdentityId: serverId,
            resolveServerFeaturesSnapshot: () => ({ status: 'ready', features }),
        });
        const result = await executor.execute('action.invoke', { action: { pluginId: 'happier.triage', localId: 'sessions/read-source-links-v1' },
            input: { v: 1, sessionId } }, { surface: 'cli' });
        expect(result, JSON.stringify({ result, reads, paths }))
            .toMatchObject({ ok: true, result: { kind: 'complete', links: [] } });
        expect(reads).toContain('source-instances');
        expect(reads).toContain('session-links');
        expect(writerClaimed).toBe(source === 'bundled');
    } finally {
        restore();
        projectionRead.mockRestore();
        await app.close();
        resetActiveAccountSettingsSnapshotForTests();
        await rm(happyHomeDir, { recursive: true, force: true });
    }
}, 120_000);
