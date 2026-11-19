import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionAwarenessProjectionV1Schema } from '@happier-dev/protocol';
import fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import {
    createLocalPathPluginDistributionIdentity,
    createPluginTrustRecord,
} from '@/plugins/store/install/trustIdentity';
import { writeCommittedLocalPathPluginFixture } from '@/plugins/store/state.testkit';
import {
    createAccountEncryptionCurrentnessFixture,
    createSessionRecordFixture,
} from '@/testkit/backends/sessionFixtures';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';

const PLUGIN_ID = 'acme.external.lane09-awareness';
const ACTION_ID = 'read-session-awareness';
const ACCOUNT_TOKEN = 'lane09-external-plugin-account-token';

const persistenceBoundary = vi.hoisted(() => ({
    readStoredCredentials: vi.fn(async () => ({
        token: 'lane09-external-plugin-account-token',
        encryption: null,
    })),
}));

vi.mock('@/persistence', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/persistence')>(),
    readStoredCredentials: persistenceBoundary.readStoredCredentials,
}));

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('installed external plugin Lane 09 awareness Action', () => {
    it('consumes the canonical marked projection through the trusted public Action service', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-lane09-plugin-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-lane09-plugin-source-'));
        const home = fastify();
        const homeUrl = 'http://lane09-plugin-home.test';
        const sessionId = 'c123456789012345678901234';
        const requests: Array<Readonly<{ path: string; authorization: string }>> = [];
        const row = createSessionRecordFixture({
            id: sessionId,
            encryptionMode: 'e2ee',
            metadata: 'retained-private-ciphertext',
            dataEncryptionKey: 'sealed-private-key',
            active: true,
            activeAt: Date.now(),
        });
        home.get(`/v2/sessions/${sessionId}`, async (request) => {
            requests.push({
                path: request.url,
                authorization: String(request.headers.authorization),
            });
            return { session: row };
        });
        home.get('/v1/account/encryption/currentness', async (request) => {
            requests.push({
                path: request.url,
                authorization: String(request.headers.authorization),
            });
            return createAccountEncryptionCurrentnessFixture({ mode: 'e2ee' });
        });
        const restoreHttp = installAxiosFastifyAdapter({ app: home, origin: homeUrl });
        let registry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'never');
        vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', '');

        try {
            await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
            await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
                schemaVersion: 2,
                id: PLUGIN_ID,
                version: '1.0.0',
                displayName: 'External Lane 09 awareness fixture',
                engines: { happier: '^0.3.0' },
                runtime: { apiVersion: 1 },
                entrypoints: { daemon: './daemon.mjs' },
                hostAccess: { required: [], optional: [] },
                contributes: {
                    actions: [{
                        id: ACTION_ID,
                        title: 'Read Session awareness',
                        scopes: ['session'],
                        surfaces: ['cli'],
                        execution: { target: 'daemon' },
                        placementBindings: ['primary'],
                        dangerLevel: 'safe',
                        inputSchema: {
                            type: 'object',
                            properties: { sessionId: { type: 'string', minLength: 1 } },
                            required: ['sessionId'],
                            additionalProperties: false,
                        },
                    }],
                },
            }), 'utf8');
            await writeFile(join(pluginRoot, 'daemon.mjs'), `
                export function activate(api) {
                    api.actions.register(${JSON.stringify(ACTION_ID)}, async (input, context) => {
                        return await context.services.actions.execute(
                            'session.activity.get',
                            { sessionId: input.sessionId, view: 'awareness' },
                            { signal: context.signal },
                        );
                    });
                }
            `, 'utf8');

            const distribution = await createLocalPathPluginDistributionIdentity(pluginRoot);
            const trust = createPluginTrustRecord({
                pluginId: PLUGIN_ID,
                distribution,
                approvedAtMs: 1,
            });
            await writeCommittedLocalPathPluginFixture({
                happyHomeDir,
                pluginId: PLUGIN_ID,
                sourceRootPath: pluginRoot,
                plugin: {
                    source: {
                        kind: 'path',
                        locator: pluginRoot,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                        resolvedPath: pluginRoot,
                        manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                    },
                    compatibility: { status: 'compatible', diagnostics: [] },
                    install: {
                        mode: 'link',
                        manifestVersion: '1.0.0',
                        installedPath: null,
                        trust,
                        updatePolicy: 'allowed',
                        optionalAccess: [],
                    },
                    state: { enabled: true },
                },
            });

            const resolvedContributes = await resolveMergedContributionRegistry({ happyHomeDir });
            const contributes = Object.freeze({
                ...resolvedContributes,
                materializationIdsByPluginId: Object.freeze({
                    ...(resolvedContributes.materializationIdsByPluginId ?? {}),
                    [PLUGIN_ID]: 'materialization-lane09-plugin-current',
                }),
            });
            expect(contributes.activationTargets.find((target) => target.pluginId === PLUGIN_ID))
                .toMatchObject({ provenance: 'external' });
            registry = await runWithServerHttpBaseUrl(homeUrl, async () => (
                await resolveExecutablePluginRuntimeRegistry({
                    happyHomeDir,
                    contributes,
                    resolveCurrentMachineId: () => 'machine-lane09-plugin',
                })
            ));
            await registry.activateContributionsOnDemand([{
                pluginId: PLUGIN_ID,
                family: 'actions',
                localId: ACTION_ID,
            }]);

            const result = await runWithServerHttpBaseUrl(homeUrl, async () => (
                await registry?.targetActionInvocations?.invoke({
                    pluginId: PLUGIN_ID,
                    localId: ACTION_ID,
                    input: { sessionId },
                    sessionId,
                    surface: 'cli',
                })
            ));

            expect(result).toEqual({ status: 'executed', value: expect.anything() });
            if (result?.status !== 'executed') throw new Error('External awareness Action did not execute');
            expect(SessionAwarenessProjectionV1Schema.safeParse(result.value).success).toBe(true);
            expect(result.value).toMatchObject({
                v: 1,
                sessionId,
                encryption: 'unknown',
                availability: 'locked',
            });
            expect(result.value).not.toHaveProperty('title');
            expect(result.value).not.toHaveProperty('workspace');
            expect(result.value).not.toHaveProperty('messageCounts');
            expect(requests).toEqual([
                { path: `/v2/sessions/${sessionId}`, authorization: `Bearer ${ACCOUNT_TOKEN}` },
                { path: '/v1/account/encryption/currentness', authorization: `Bearer ${ACCOUNT_TOKEN}` },
            ]);
        } finally {
            restoreHttp();
            await registry?.dispose();
            await home.close();
            await Promise.all([
                rm(happyHomeDir, { recursive: true, force: true }),
                rm(pluginRoot, { recursive: true, force: true }),
            ]);
        }
    }, 60_000);
});
