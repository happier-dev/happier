import fastify from 'fastify';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { readDeclaredPackageAssetsV1 } from '@happier-dev/protocol/plugins/availability/packageAssetV1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { encodePluginCollectionLogicalValueV1 } from '@happier-dev/protocol/plugins/data/collectionLogicalCodecV1';
import { normalizePluginAccountCollectionContractV1, PLUGIN_COLLECTION_QUERY_HTTP_PATH_V1 } from '@happier-dev/protocol';
import { TRIAGE_ISSUE_SETUP_ACTION_LOCAL_ID_V1 } from '@happier-dev/triage-sources/runtime';

import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import * as persistence from '@/persistence';
import { createAuthoredAdmittedPluginRuntimeFixture, requireDaemonEntrypoint } from '@/plugins/testkit/admittedRuntime';
import { registerAuthoredAccountActionRelease } from '@/plugins/runtime/accountPluginActions.testkit';
import { createCommittedContributedActionDefinitionLister, createCommittedContributedActionSchemaReader, createCommittedInputTypeDeps } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { ensureCliActionPolicySettings } from '@/session/actions/ensureCliActionPolicySettings';
import { registerAccountHomeHttp } from '@/session/actions/widgetApproval.testkit';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';

import { PLUGIN_MANIFEST as triage, TRIAGE_PLUGIN } from '../../../../../packages/plugins/triage/src/manifest';
import { PLUGIN_MANIFEST as sentry } from '../../../../../packages/plugins/sentry/src/manifest';
import { SENTRY_CONTRIBUTION_ID, SENTRY_PLUGIN_ID } from '../../../../../packages/plugins/sentry/src/sentryContracts';
import { activate as activateSentry } from '../../../../../packages/plugins/sentry/src/activate';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE, CORPUS_SOURCE_INSTANCES_COLLECTION_ID } from '../../../../../packages/plugins/triage/src/corpus/collections/ids';

it('settles cold Sentry Watch Source options with zero and one Account source', { timeout: 60_000 }, async () => {
    const accountId = 'watch-options-owner';
    const origin = 'http://watch-options.test';
    const credentials = { token: 'e30.' + Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url') + '.signature', encryption: null };
    const source = { pluginId: SENTRY_PLUGIN_ID, localId: SENTRY_CONTRIBUTION_ID };
    const sourceInstanceId = '00000001-1111-4111-8111-111111111111';
    const stored = {
        instanceTag: 't' + '0'.repeat(42),
        sourceQualifiedId: `${source.pluginId}/${source.localId}`,
        lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1,
        configured: {
            v: 1, instance: { source, sourceInstanceId },
            binding: { purpose: 'triage-source', account: { service: { pluginId: source.pluginId, localId: 'accounts' }, accountId: 'fixture' } },
            localInstanceKey: 'fixture', configuration: { v: 1, token: 'fixture-routing' },
            locator: { v: 1, displayLabel: 'Fixture Sentry' },
        },
    };
    const contribution = triage.contributes?.accountCollections?.find(({ id }) => id === CORPUS_SOURCE_INSTANCES_COLLECTION_ID);
    if (contribution === undefined) throw new Error('Triage is missing its configured sources Collection declaration');
    const contract = normalizePluginAccountCollectionContractV1({ pluginId: triage.id, contribution });
    const encoded = encodePluginCollectionLogicalValueV1({
        contract, isValidLogicalValue: compilePluginJsonSchema(contract.schema), value: stored,
        encryptionMode: 'plain', material: null, randomBytes: length => new Uint8Array(length),
    });
    if (encoded.status !== 'encoded') throw new Error(`Invalid configured Sentry fixture: ${encoded.reason}`);
    const row = { rowId: encoded.rowId, revision: 1, projection: encoded.projection, content: encoded.content };
    const readCredentials = vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    const socket = await createRequesterCurrentnessSocketHarness();
    const app = fastify();
    const features = registerAccountHomeHttp(app, { accountId, serverId: 'watch-options-home' });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/encryption/currentness') return Response.json(createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
        if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
        throw new Error(`Unexpected fixture fetch: ${path}`);
    });
    let configured = false;
    let runtime: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | undefined;
    let restore: (() => void) | undefined;
    try {
        const projectRoot = resolve(import.meta.dirname, '../../../../../packages/plugins/triage');
        const authored = await registerAuthoredAccountActionRelease(app, accountId, { primary: {
            manifest: triage, projectRoot, entryPath: resolve(projectRoot, 'src/accountRuntime.ts'),
            artifactId: 'triage-account-runtime', manifestExport: null, activateExport: 'activate',
        }, includeBundledPluginIds: [sentry.id] });
        app.post<{ Body: { collectionId: string } }>(PLUGIN_COLLECTION_QUERY_HTTP_PATH_V1, async request => ({
            rows: configured && request.body.collectionId === CORPUS_SOURCE_INSTANCES_COLLECTION_ID ? [row] : [],
            changeCursor: configured ? 2 : 1,
        }));
        await app.ready();
        restore = installAxiosFastifyAdapter({ app, origin });
        const pluginFiles = async (manifest: typeof triage | typeof sentry, root: string) => {
            const assets = readDeclaredPackageAssetsV1(manifest);
            if (!assets) throw new Error('Expected declared plugin assets');
            return {
                ...Object.fromEntries(await Promise.all(assets.map(async ({ path }) => [path, await readFile(resolve(root, path))]))),
                [requireDaemonEntrypoint(manifest)]: 'export function activate() {}',
            };
        };
        await runWithServerHttpBaseUrl(origin, async () => {
            await authored.publishArtifacts(credentials);
            runtime = await createAuthoredAdmittedPluginRuntimeFixture({
                coldStart: true,
                runtimeOptions: { scopedActionRuntime: { credentials, actionsSettingsProvider: createActionSettingsProvider() } },
                plugins: [
                    { manifest: triage, files: await pluginFiles(triage, projectRoot),
                        instantiateCommittedModule: () => ({ activate: TRIAGE_PLUGIN.activate }) },
                    { manifest: sentry, files: await pluginFiles(sentry, resolve(projectRoot, '../sentry')),
                        instantiateCommittedModule: () => ({ activate: activateSentry }) },
                ],
            });
            await ensureCliActionPolicySettings(credentials, origin);
            const { controller } = runtime;
            const listDefinitions = createCommittedContributedActionDefinitionLister({
                tryAcquireRuntimeRegistryLease: () => controller.tryAcquireRuntimeRegistry(),
            });
            const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
                listContributedActionDefinitions: listDefinitions,
                readContributedActionSchemas: createCommittedContributedActionSchemaReader(listDefinitions),
                ...createCommittedInputTypeDeps({ acquireRuntimeRegistryLease: () => controller.acquireRuntimeRegistry() }),
            });
            const actionId = formatQualifiedPluginActionId({ pluginId: source.pluginId, localId: TRIAGE_ISSUE_SETUP_ACTION_LOCAL_ID_V1 });
            expect(await executor.execute('action.spec.get', { id: actionId }, { surface: 'agent' })).toMatchObject({
                ok: true, result: { actionSpec: { id: actionId, inputSchema: {
                    properties: { sourceInstanceId: expect.any(Object) },
                } } },
            });
            const resolveSource = () => executor.execute('action.options.resolve', {
                actionId,
                fieldPath: 'sourceInstanceId', draftInput: {},
            }, { surface: 'ui' });
            const empty = await resolveSource();
            expect(empty.ok ? undefined : empty.errorCode).toBeUndefined();
            expect(empty).toMatchObject({ ok: true, result: { options: [] } });
            configured = true;
            const result = await resolveSource();
            expect(result.ok ? undefined : result.errorCode).toBeUndefined();
            expect(result).toMatchObject({ ok: true, result: { options: [{ value: sourceInstanceId, label: 'Fixture Sentry' }] } });
        });
    } finally {
        await runtime?.dispose();
        restore?.();
        readCredentials.mockRestore();
        fetch.mockRestore();
        resetActiveAccountSettingsSnapshotForTests();
        await socket.close();
        await app.close();
    }
});
