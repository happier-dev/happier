import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveExecutablePluginRuntimeRegistry, type ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import {
    createLocalPathPluginDistributionIdentity,
    createPluginTrustRecord,
} from '@/plugins/store/install/trustIdentity';
import { writeCommittedLocalPathPluginFixture } from '@/plugins/store/state.testkit';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';

const PLUGIN_ID = 'acme.external.lane10-actions';
const ACTION_ID = 'read-entitled-credentials';
const ACCOUNT_TOKEN = 'lane10-external-plugin-account-token';

const persistenceBoundary = vi.hoisted(() => ({
    readStoredCredentials: vi.fn(async () => ({
        token: 'lane10-external-plugin-account-token',
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

describe('installed external plugin Lane 10 Actions', () => {
    it('reaches the same trusted host Action through only the public activate(api) ABI', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-lane10-plugin-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-lane10-plugin-source-'));
        const home = fastify();
        const homeUrl = 'http://lane10-plugin-home.test';
        const requests: Array<Readonly<{ authorization: string; body: unknown }>> = [];
        home.post('/v1/teams/credential-resources/entitled/list', async (request) => {
            requests.push({
                authorization: String(request.headers.authorization),
                body: request.body,
            });
            return { resources: [], nextCursor: null };
        });
        const restoreHttp = installAxiosFastifyAdapter({ app: home, origin: homeUrl });
        let registry: ResolvedExecutablePluginRuntimeRegistry | null = null;
        vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'never');
        vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', '');

        try {
            await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
            await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
                schemaVersion: 2,
                id: PLUGIN_ID,
                version: '1.0.0',
                displayName: 'External Lane 10 Action fixture',
                engines: { happier: '^0.3.0' },
                runtime: { apiVersion: 1 },
                entrypoints: { daemon: './daemon.mjs' },
                hostAccess: { required: [], optional: [] },
                contributes: {
                    actions: [{
                        id: ACTION_ID,
                        title: 'Read entitled Team credentials',
                        scopes: ['global'],
                        surfaces: ['cli'],
                        execution: { target: 'daemon' },
                        placementBindings: ['primary'],
                        dangerLevel: 'safe',
                        inputSchema: {
                            type: 'object',
                            properties: { teamId: { type: 'string', minLength: 1 } },
                            required: ['teamId'],
                            additionalProperties: false,
                        },
                    }],
                },
            }), 'utf8');
            await writeFile(join(pluginRoot, 'daemon.mjs'), `
                export function activate(api) {
                    api.actions.register(${JSON.stringify(ACTION_ID)}, async (input, context) => {
                        return await context.services.actions.execute(
                            'teams.credentials.entitled.list',
                            { teamId: input.teamId },
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
            // Production supplies this identity from the installed plugin's
            // Machine materialization. This external fixture has no daemon
            // installer, so project the same host-owned fact explicitly.
            const contributes = Object.freeze({
                ...resolvedContributes,
                materializationIdsByPluginId: Object.freeze({
                    ...(resolvedContributes.materializationIdsByPluginId ?? {}),
                    [PLUGIN_ID]: 'materialization-lane10-plugin-current',
                }),
            });
            expect(contributes.activationTargets.find((target) => target.pluginId === PLUGIN_ID))
                .toMatchObject({ provenance: 'external' });
            registry = await runWithServerHttpBaseUrl(homeUrl, async () => (
                await resolveExecutablePluginRuntimeRegistry({
                    happyHomeDir,
                    contributes,
                    // The real daemon supplies the current Machine at this
                    // boundary. Keep the external-plugin proof on the same
                    // host-stamped currentness path as bundled plugins.
                    resolveCurrentMachineId: () => 'machine-lane10-plugin',
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
                    input: { teamId: 'team-1' },
                    surface: 'cli',
                })
            ));

            expect(result).toEqual({
                status: 'executed',
                value: { resources: [], nextCursor: null },
            });
            expect(requests).toEqual([{
                authorization: `Bearer ${ACCOUNT_TOKEN}`,
                body: expect.objectContaining({ teamId: 'team-1' }),
            }]);
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
