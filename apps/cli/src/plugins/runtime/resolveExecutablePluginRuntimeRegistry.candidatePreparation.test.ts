import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import {
    normalizePluginAccountCollectionContractsV1,
    PluginUiArtifactDigestV1Schema,
    type PluginAccountCollectionContributionV1,
} from '@happier-dev/protocol';
import type { StoredCredentials } from '@/persistence';

import type {
    AccountPluginDataStorageHostDependencies,
} from './context/accountPluginDataStorage';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';
import { resolvePluginContributes } from '@/plugins/projection/registry/resolvePluginContributions';
import { resolveLocalPathPluginSource } from '@/plugins/discovery/sources/localPath';
import { evaluateManifestPluginDevelopmentCandidate } from '@/plugins/authoring/sourceModule';
import { bindPluginRuntimeSourceAuthority } from './sourceAuthority';

import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';

const pluginId = 'acme.collection-candidate';
const collectionId = 'tasks';
const targetVersion = '2.0.0';
const currentArtifactDigest = PluginUiArtifactDigestV1Schema.parse(`sha256:${'a'.repeat(64)}`);
const forgedArtifactDigest = PluginUiArtifactDigestV1Schema.parse(`sha256:${'b'.repeat(64)}`);
const moduleLoadMarker = '__happier_collection_candidate_module_loads__';

const sourceCollection: PluginAccountCollectionContributionV1 = {
    id: collectionId,
    schemaVersion: 1,
    schema: {
        type: 'object',
        properties: {
            id: { type: 'string', maxLength: 256 },
        },
        required: ['id'],
        additionalProperties: false,
    },
    rowIdField: 'id',
    serverReadable: ['id'],
    indexes: [],
    uiQueries: [],
    relations: [],
    identityFields: [],
    migrations: [],
};

const targetCollection = Object.freeze({
    id: collectionId,
    schemaVersion: 2,
    readableSchemaVersions: [1],
    schema: {
        type: 'object',
        properties: {
            id: { type: 'string', maxLength: 256 },
            status: { type: 'string', maxLength: 256 },
        },
        required: ['id', 'status'],
        additionalProperties: false,
    },
    rowIdField: 'id',
    serverReadable: ['id', 'status'],
    indexes: [],
    uiQueries: [],
    relations: [],
    migrations: [{
        id: 'tasks-v1-to-v2',
        fromSchemaVersion: 1,
        toSchemaVersion: 2,
    }],
} as const);

function accountStorageDependencies(postCalls: unknown[]): AccountPluginDataStorageHostDependencies {
    const credentials = { token: 'candidate-account-token', encryption: null } satisfies StoredCredentials;
    return Object.freeze({
        readCredentials: async () => credentials,
        isCurrentAccount: (current) => current.token === credentials.token,
        resolveAccountScopeKey: () => 'candidate-account-scope',
        resolveBaseUrl: () => 'https://data.example.test',
        resolveAccountEncryptionCurrentness: async () => ({
            mode: 'plain' as const,
            version: 1,
            signingKeyFingerprint: null,
            contentKeyFingerprint: null,
            updatedAt: 1,
            recipientEnvelopeReadiness: { status: 'unavailable' as const, reason: 'plain_account' as const },
        }),
        http: {
            async get(url: string) {
                if (url.endsWith('/v1/account/encryption')) {
                    return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
                }
                throw new Error(`Unexpected candidate-preparation GET: ${url}`);
            },
            async post(url: string, body: string) {
                postCalls.push({ url, body: JSON.parse(body) });
                throw new Error(`Forged candidate digest must not prepare Account Data: ${url}`);
            },
        },
    });
}

async function seedCandidateFixture(input: Readonly<{
    happyHomeDir: string;
    pluginRoot: string;
    readCollection?: boolean;
}>): Promise<void> {
    const manifest = {
        schemaVersion: 2,
        id: pluginId,
        version: targetVersion,
        displayName: 'Candidate preparation fixture',
        engines: { happier: '^0.2.0' },
        runtime: { apiVersion: 1 },
        entrypoints: { daemon: './daemon.mjs', ...(input.readCollection ? { development: './daemon.mjs' } : {}) },
        hostAccess: { required: input.readCollection ? [{ id: 'account-state', capability: 'storage.account', reason: 'Read retained tasks.', scope: { enabled: true } }] : [], optional: [] },
        contributes: {
            actions: [{
                id: 'candidate-action',
                title: 'Candidate action',
                scopes: ['global'],
                surfaces: ['cli'],
                execution: { target: 'daemon' },
                placementBindings: ['primary'],
                dangerLevel: 'safe',
                ...(input.readCollection ? { hostAccess: ['account-state'] } : {}),
            }],
            accountCollections: [targetCollection],
            ui: {
                renderers: [{
                    id: 'candidate-migrations',
                    kind: 'reactNative',
                    artifact: 'candidate-migrations-artifact',
                    requiredHostMethods: [],
                }],
            },
        },
    };
    const artifactManifest = {
        version: 1,
        entries: [{
            contributionId: 'candidate-migrations-artifact',
            tier: 'reactNative',
            platform: 'ios',
            entry: 'react-native/candidate/ios.bundle',
            files: [{
                relativePath: 'react-native/candidate/ios.bundle',
                digest: currentArtifactDigest,
                byteSize: 1,
            }],
            digest: currentArtifactDigest,
            builtWith: { bundler: 'repack', version: '5.2.5' },
            repack: {
                containerName: 'candidate_migrations',
                modulePath: './renderSurface',
                exportName: 'renderSurface',
            },
            collectionMigrations: {
                containerName: 'candidate_migrations',
                modulePath: './renderSurface',
                exportName: 'collectionMigrations',
            },
            hostUiApiVersion: '1.0.0',
            compat: { react: '19.2.0', reactNative: '0.83.4' },
        }],
    };
    await mkdir(join(input.pluginRoot, '.happier-plugin'), { recursive: true });
    await mkdir(join(input.pluginRoot, 'dist', 'happier-plugin-ui'), { recursive: true });
    await writeFile(
        join(input.pluginRoot, '.happier-plugin', 'plugin.json'),
        JSON.stringify(manifest),
        'utf8',
    );
    await writeFile(
        join(input.pluginRoot, 'dist', 'happier-plugin-ui', 'ui-artifacts.json'),
        JSON.stringify(artifactManifest),
        'utf8',
    );
    await writeFile(join(input.pluginRoot, 'daemon.mjs'), [
        `globalThis[${JSON.stringify(moduleLoadMarker)}] = (globalThis[${JSON.stringify(moduleLoadMarker)}] ?? 0) + 1;`,
        `export const manifest = ${JSON.stringify(manifest)};`,
        'export function activate(api) {',
        input.readCollection
            ? `  api.actions.register('candidate-action', async (_input, context) => { const row = await context.services.storage.account.collection({ ...manifest.contributes.accountCollections[0], migrations: collectionMigrations.tasks }).get('task-1'); return { status: row?.value.status ?? null }; });`
            : "  api.actions.register('candidate-action', async () => ({ ok: true }));",
        '}',
        'export const collectionMigrations = {',
        `  ${JSON.stringify(collectionId)}: [{`,
        "    id: 'tasks-v1-to-v2',",
        '    fromSchemaVersion: 1,',
        '    toSchemaVersion: 2,',
        "    migrate: (value) => ({ ...value, status: 'open' }),",
        '  }],',
        '};',
        '',
    ].join('\n'), 'utf8');
    await seedCurrentLocalPathPluginFixture({
        happyHomeDir: input.happyHomeDir,
        pluginRoot: input.pluginRoot,
        pluginId,
        manifestVersion: targetVersion,
    });
}

describe('Collection candidate preparation runtime owner', () => {
    it('loads the declaring release-less module and migrates retained rows before an Action reads them', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-release-less-preparation-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-release-less-preparation-plugin-'));
        let runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        const [source] = normalizePluginAccountCollectionContractsV1({ pluginId, contributions: [sourceCollection] });
        const ref = (contract: NonNullable<typeof source>) => ({ pluginId, collectionId, schemaVersion: contract.schemaVersion, contractDigest: contract.contractDigest });
        let staged = false;
        let promoted = false;
        const requests: string[] = [];
        try {
            await seedCandidateFixture({ happyHomeDir, pluginRoot, readCollection: true });
            const contributes = await resolvePluginContributes({ happyHomeDir, existingAgentIds: new Set() });
            const target = contributes.activationTargets?.find((entry) => entry.pluginId === pluginId);
            if (!target?.daemonEntryPath) throw new Error('Expected the fixture daemon entry');
            const physicalSource = await resolveLocalPathPluginSource({ locator: target.sourceSpec?.resolvedPath ?? pluginRoot });
            if (!physicalSource.ok) throw new Error('Expected the physical fixture source');
            // The process-boundary fixture admits a real evaluated development graph,
            // not a callback/loader replacement or an unaccepted devWatch flag.
            const authority = bindPluginRuntimeSourceAuthority({
                custody: { kind: 'development', registeredRootId: physicalSource.pluginRootPath },
                resolvedRoot: physicalSource.pluginRootPath,
                observedRevision: 1,
            });
            if (authority.kind !== 'development') throw new Error('Expected development source custody');
            const development = await evaluateManifestPluginDevelopmentCandidate({ source: physicalSource, sourceAuthority: authority });
            const dependencies = accountStorageDependencies([]);
            runtime = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir, pluginIds: [pluginId],
                contributes,
                preparedDevelopmentActivationGraphsByPluginId: new Map([[pluginId, development.graph]]),
                resolveCurrentMachineId: () => 'candidate-machine',
                resolveCurrentMachineExecutionOriginContext: async () => ({
                    serverIdentityId: 'srv_candidate_fixture',
                    machineId: 'candidate-machine',
                }),
                accountStorageDependencies: {
                    ...dependencies,
                    http: {
                        ...dependencies.http!,
                        async post(url, body) {
                            requests.push(url);
                            // Genuine HTTP boundary fixture; schemas below own the real host path.
                            const request = JSON.parse(body);
                            const [target] = normalizePluginAccountCollectionContractsV1({ pluginId, contributions: [targetCollection] });
                            if (url.endsWith('/collection-writers/claim')) {
                                const intent = { pluginId, desiredVersion: null, enabled: true, offlineUiHosting: 'disabled', writableCollections: [ref(source!)], revision: '0' };
                                if (request.prepare) return { status: 200, data: { intent, preparation: [{ source: sourceCollection, binding: { source: ref(source!), target: ref(target!), candidate: { releaseVersion: targetVersion, artifactDigest: currentArtifactDigest, releaseLessManifest: request.manifest } } }] } };
                                if (!staged) return { status: 409, data: { error: 'plugin_intent_writable_collections_not_ready' } };
                                promoted = true;
                                return { status: 200, data: { intent: { ...intent, writableCollections: [ref(target!)], revision: '1' } } };
                            }
                            if (url.endsWith('/candidate-preparation/source-page')) return { status: 200, data: { rows: [{ rowId: 'task-1', revision: 1, content: { t: 'plain', v: {} }, projection: { id: 'task-1' }, alreadyStaged: false }] } };
                            if (url.endsWith('/candidate-preparation/stage')) {
                                expect(request.items[0].target).toEqual({ content: { t: 'plain', v: {} }, projection: { id: 'task-1', status: 'open' } });
                                expect(promoted).toBe(false);
                                staged = true;
                                return { status: 200, data: { results: [{ status: 'staged' }] } };
                            }
                            return { status: 200, data: { row: promoted ? { rowId: 'task-1', revision: 2, content: { t: 'plain', v: {} }, projection: { id: 'task-1', status: 'open' } } : null, absenceEpoch: 0 } };
                        },
                    },
                },
            });
            await runtime.activateContributionsOnDemand([{ pluginId, family: 'actions', localId: 'candidate-action' }]);
            expect(runtime.pluginDiagnosticsByPluginId[pluginId] ?? []).toEqual([]);
            const result = await runtime.targetActionInvocations?.invoke({ pluginId, localId: 'candidate-action', input: {}, surface: 'cli' });
            expect(staged, JSON.stringify(requests)).toBe(true);
            expect(result).toEqual({ status: 'executed', value: { status: 'open' } });
            expect(promoted).toBe(true);
        } finally {
            await runtime?.dispose();
            Reflect.deleteProperty(globalThis, moduleLoadMarker);
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
        }
    }, 60_000);
    it('rejects a caller-forged artifact digest before loading candidate code or preparing Account Data', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-candidate-preparation-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-candidate-preparation-plugin-'));
        const postCalls: unknown[] = [];
        let runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;

        try {
            await seedCandidateFixture({ happyHomeDir, pluginRoot });
            runtime = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                pluginIds: [pluginId],
                resolveCurrentMachineId: () => 'candidate-machine',
                resolveCurrentMachineExecutionOriginContext: async () => ({
                    serverIdentityId: 'srv_candidate_fixture',
                    machineId: 'candidate-machine',
                }),
                accountStorageDependencies: accountStorageDependencies(postCalls),
            });
            await expect(runtime.activateContributionsOnDemand([{
                pluginId,
                family: 'actions',
                localId: 'candidate-action',
            }])).resolves.toEqual([expect.objectContaining({ pluginId, diagnostics: [] })]);
            postCalls.length = 0;
            Reflect.set(globalThis, moduleLoadMarker, 0);

            const sourceContract = normalizePluginAccountCollectionContractsV1({
                pluginId,
                contributions: [sourceCollection],
            })[0];
            const targetContract = runtime.contributes.accountCollections?.find((contract) => (
                contract.pluginId === pluginId && contract.definition.collectionId === collectionId
            ))?.definition;
            const origin = await runtime.resolveCurrentPluginExecutionOrigin?.(pluginId);
            if (!sourceContract || !targetContract || !origin || !runtime.prepareCollectionMigrationCandidates) {
                throw new Error('Expected exact current candidate-preparation runtime facts');
            }

            await expect(runtime.prepareCollectionMigrationCandidates({
                source: {
                    release: { pluginId, version: '1.0.0' },
                    collectionContracts: [sourceContract],
                },
                candidate: {
                    release: { pluginId, version: targetVersion },
                    artifactDigest: forgedArtifactDigest,
                    origin,
                    collectionContracts: [{
                        pluginId: targetContract.pluginId,
                        collectionId: targetContract.collectionId,
                        schemaVersion: targetContract.schemaVersion,
                        contractDigest: targetContract.contractDigest,
                    }],
                },
                signal: new AbortController().signal,
                isRequestCurrent: () => true,
            })).resolves.toEqual({
                kind: 'unavailable',
                code: 'candidate_contract_mismatch',
            });
            expect(Reflect.get(globalThis, moduleLoadMarker)).toBe(0);
            expect(postCalls).toEqual([]);
        } finally {
            await runtime?.dispose();
            Reflect.deleteProperty(globalThis, moduleLoadMarker);
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
        }
    }, 60_000);
});
