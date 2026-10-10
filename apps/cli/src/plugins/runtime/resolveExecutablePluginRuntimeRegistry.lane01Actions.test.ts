import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, normalizeActionsSettingsV1 } from '@happier-dev/protocol';
import { NO_TEAM_CAPABILITIES_V1 } from '@happier-dev/protocol/teams';

import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import {
    createLocalPathPluginDistributionIdentity,
    createPluginTrustRecord,
} from '@/plugins/store/install/trustIdentity';
import { writeCommittedLocalPathPluginFixture } from '@/plugins/store/state.testkit';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import {
    resetActiveAccountSettingsSnapshotForTests,
    setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createScopedRuntimeActionSettingsProvider } from '@/settings/scopedRuntimeActionSettingsProvider';

const PLUGIN_ID = 'acme.external.lane01-actions';
const ACTION_ID = 'archive-team';
const ACCOUNT_TOKEN = 'lane01-external-plugin-account-token';

const persistenceBoundary = vi.hoisted(() => ({
    readStoredCredentials: vi.fn(async () => ({ token: ACCOUNT_TOKEN, encryption: null })),
}));
const activeAccountBoundary = vi.hoisted(() => ({
    readSnapshot: vi.fn(),
    readLifetime: vi.fn(),
    subscribe: vi.fn(),
}));

vi.mock('@/persistence', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/persistence')>(),
    readStoredCredentials: persistenceBoundary.readStoredCredentials,
}));

vi.mock('@/settings/accountSettings/activeAccountSettingsSnapshot', async (importOriginal) => {
    const original = await importOriginal<
        typeof import('@/settings/accountSettings/activeAccountSettingsSnapshot')
    >();
    return {
        ...original,
        getActiveAccountSettingsSnapshot: (...args: Parameters<
            typeof original.getActiveAccountSettingsSnapshot
        >) => {
            activeAccountBoundary.readSnapshot(...args);
            return original.getActiveAccountSettingsSnapshot(...args);
        },
        getActiveAccountSettingsSnapshotLifetimeToken: (...args: Parameters<
            typeof original.getActiveAccountSettingsSnapshotLifetimeToken
        >) => {
            activeAccountBoundary.readLifetime(...args);
            return original.getActiveAccountSettingsSnapshotLifetimeToken(...args);
        },
        subscribeActiveAccountSettingsSnapshot: (...args: Parameters<
            typeof original.subscribeActiveAccountSettingsSnapshot
        >) => {
            activeAccountBoundary.subscribe(...args);
            return original.subscribeActiveAccountSettingsSnapshot(...args);
        },
    };
});

afterEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
    vi.unstubAllEnvs();
});

describe('installed external plugin Lane 01 Actions', () => {
    it('reaches the canonical Team transport through only the public activate(api) ABI', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-lane01-plugin-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-lane01-plugin-source-'));
        const home = fastify();
        const homeUrl = 'http://lane01-plugin-home.test';
        const requests: Array<Readonly<{ authorization: string; body: unknown }>> = [];
        const team = {
            id: 'team-1', name: 'Platform', description: null, logo: null,
            archivedAt: 1, recovery: null,
            policy: {
                v: 1, sessionCreationPolicy: 'private_default', externalSharingPolicy: 'allowed',
                defaultSessionHistoryAccess: 'from_membership', admissionMode: 'invite_only',
                authenticationPolicy: null, authenticationPolicyStatus: 'available',
            },
            viewerRole: 'owner',
            capabilities: NO_TEAM_CAPABILITIES_V1,
            admission: { historyChoice: { admin: 'choice', member: 'choice', guest: 'hidden' } },
            counts: null,
        };
        home.get('/v1/account/encryption', async () => ({ mode: 'plain' }));
        home.post('/v1/teams/archive', async (request) => {
            requests.push({
                authorization: String(request.headers.authorization),
                body: request.body,
            });
            return team;
        });
        const restoreHttp = installAxiosFastifyAdapter({ app: home, origin: homeUrl });
        let registry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'never');
        // Credential-scoped runtimes must ignore this unscoped environment
        // policy and consume the matching Account snapshot below.
        vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', JSON.stringify({ v: 1, actions: {} }));
        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: accountSettingsParse({
                actionsSettingsV1: {
                    v: 1,
                    actions: {},
                    approvalWaivedSurfaces: { 'teams.archive': ['plugin'] },
                },
            }),
            settingsVersion: 1,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: resolveAccountSettingsScopeKeyForToken(ACCOUNT_TOKEN),
        });

        try {
            await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
            await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
                schemaVersion: 2,
                id: PLUGIN_ID,
                version: '1.0.0',
                displayName: 'External Lane 01 Action fixture',
                engines: { happier: '^0.2.0' },
                runtime: { apiVersion: 1 },
                entrypoints: { daemon: './daemon.mjs' },
                hostAccess: { required: [], optional: [] },
                contributes: {
                    actions: [{
                        id: ACTION_ID,
                        title: 'Archive Team',
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
                    events: [{
                        id: 'runtime-policy-event',
                        kind: 'event',
                        title: 'Runtime policy event',
                    }],
                    notifications: [{
                        id: 'runtime-policy',
                        kind: 'activity',
                        title: 'Runtime policy',
                        eventIds: ['runtime-policy-event'],
                        defaultChannels: [],
                    }],
                },
            }), 'utf8');
            await writeFile(join(pluginRoot, 'daemon.mjs'), `
                export function activate(api) {
                    api.actions.register(${JSON.stringify(ACTION_ID)}, async (input, context) => {
                        await context.services.notifications.preferences('runtime-policy');
                        const preferenceWatch = context.services.notifications.watchPreferences(
                            'runtime-policy',
                            () => {},
                        );
                        preferenceWatch.dispose();
                        return await context.services.actions.execute(
                            'teams.archive',
                            { v: 1, teamId: input.teamId },
                            { signal: context.signal },
                        );
                    });
                }
            `, 'utf8');

            const distribution = await createLocalPathPluginDistributionIdentity(pluginRoot);
            const trust = createPluginTrustRecord({ pluginId: PLUGIN_ID, distribution, approvedAtMs: 1 });
            await writeCommittedLocalPathPluginFixture({
                happyHomeDir,
                pluginId: PLUGIN_ID,
                sourceRootPath: pluginRoot,
                plugin: {
                    source: {
                        kind: 'path', locator: pluginRoot, trustPolicy: 'local_trusted', installPolicy: 'link',
                        resolvedPath: pluginRoot, manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                    },
                    compatibility: { status: 'compatible', diagnostics: [] },
                    install: {
                        mode: 'link', manifestVersion: '1.0.0', installedPath: null, trust,
                        updatePolicy: 'allowed', optionalAccess: [],
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
                    [PLUGIN_ID]: 'materialization-lane01-plugin-current',
                }),
            });
            expect(contributes.activationTargets.find((target) => target.pluginId === PLUGIN_ID))
                .toMatchObject({ provenance: 'external' });
            registry = await runWithServerHttpBaseUrl(homeUrl, async () => (
                await resolveExecutablePluginRuntimeRegistry({
                    happyHomeDir,
                    contributes,
                    pluginIds: [PLUGIN_ID],
                    // The real daemon supplies the current Machine at this
                    // boundary. Keep this external-plugin journey on that
                    // host-stamped provenance path instead of bypassing the
                    // canonical Action caller/currentness check.
                    resolveCurrentMachineId: () => 'machine-lane01-plugin',
                })
            ));
            await registry.activateContributionsOnDemand([{
                pluginId: PLUGIN_ID, family: 'actions', localId: ACTION_ID,
            }]);

            const result = await runWithServerHttpBaseUrl(homeUrl, async () => (
                await registry?.targetActionInvocations?.invoke({
                    pluginId: PLUGIN_ID, localId: ACTION_ID,
                    input: { teamId: 'team-1' }, surface: 'cli',
                })
            ));

            expect(result).toEqual({ status: 'executed', value: team });
            expect(requests).toEqual([{
                authorization: `Bearer ${ACCOUNT_TOKEN}`,
                body: { v: 1, teamId: 'team-1' },
            }]);

            await registry.dispose();
            registry = null;
            requests.length = 0;
            persistenceBoundary.readStoredCredentials.mockClear();
            activeAccountBoundary.readSnapshot.mockClear();
            activeAccountBoundary.readLifetime.mockClear();
            activeAccountBoundary.subscribe.mockClear();
            const scopedToken = 'restricted-runner-runtime-token';
            registry = await runWithServerHttpBaseUrl(homeUrl, async () => (
                await resolveExecutablePluginRuntimeRegistry({
                    happyHomeDir,
                    contributes,
                    pluginIds: [PLUGIN_ID],
                    resolveCurrentMachineId: () => 'machine-lane01-plugin',
                    scopedActionRuntime: {
                        credentials: { token: scopedToken, encryption: null },
                        actionsSettingsProvider: createScopedRuntimeActionSettingsProvider(
                            normalizeActionsSettingsV1({
                                v: 1,
                                actions: {},
                                approvalWaivedSurfaces: { 'teams.archive': ['plugin'] },
                            }),
                        ),
                    },
                })
            ));
            expect(registry.currentGlobalExternalSessionsTarget).toBeDefined();
            expect(registry.currentGlobalExternalSessionsTarget?.resolveCurrent()).toBeNull();
            await registry.activateContributionsOnDemand([{
                pluginId: PLUGIN_ID, family: 'actions', localId: ACTION_ID,
            }]);

            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({
                    actionsSettingsV1: {
                        v: 1,
                        actions: { 'teams.archive': { enabled: false } },
                    },
                }),
                settingsVersion: 2,
                loadedAtMs: 2,
                settingsSecretsReadKeys: [],
                scopeKey: resolveAccountSettingsScopeKeyForToken('different-account-token'),
            });

            await expect(runWithServerHttpBaseUrl(homeUrl, async () => (
                await registry?.targetActionInvocations?.invoke({
                    pluginId: PLUGIN_ID, localId: ACTION_ID,
                    input: { teamId: 'team-2' }, surface: 'cli',
                })
            ))).resolves.toMatchObject({ status: 'executed' });
            expect(requests).toEqual([{
                authorization: `Bearer ${scopedToken}`,
                body: { v: 1, teamId: 'team-2' },
            }]);
            resetActiveAccountSettingsSnapshotForTests();
            await expect(runWithServerHttpBaseUrl(homeUrl, async () => (
                await registry?.targetActionInvocations?.invoke({
                    pluginId: PLUGIN_ID, localId: ACTION_ID,
                    input: { teamId: 'team-2-cleared' }, surface: 'cli',
                })
            ))).resolves.toMatchObject({ status: 'executed' });
            expect(requests).toEqual([{
                authorization: `Bearer ${scopedToken}`,
                body: { v: 1, teamId: 'team-2' },
            }, {
                authorization: `Bearer ${scopedToken}`,
                body: { v: 1, teamId: 'team-2-cleared' },
            }]);
            expect(persistenceBoundary.readStoredCredentials).not.toHaveBeenCalled();
            expect(activeAccountBoundary.readSnapshot).not.toHaveBeenCalled();
            expect(activeAccountBoundary.readLifetime).not.toHaveBeenCalled();
            expect(activeAccountBoundary.subscribe).not.toHaveBeenCalled();

            await registry.dispose();
            registry = null;
            requests.length = 0;
            registry = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                contributes,
                pluginIds: [PLUGIN_ID],
                resolveCurrentMachineId: () => 'machine-lane01-plugin',
                scopedActionRuntime: {
                    credentials: { token: scopedToken, encryption: null },
                    actionsSettingsProvider: createScopedRuntimeActionSettingsProvider(
                        normalizeActionsSettingsV1({
                            v: 1,
                            actions: { 'teams.archive': { enabled: false } },
                        }),
                    ),
                },
            });
            await registry.activateContributionsOnDemand([{
                pluginId: PLUGIN_ID, family: 'actions', localId: ACTION_ID,
            }]);
            await expect(registry.targetActionInvocations?.invoke({
                pluginId: PLUGIN_ID, localId: ACTION_ID,
                input: { teamId: 'team-3' }, surface: 'cli',
            })).resolves.toMatchObject({ status: 'failed' });
            expect(requests).toEqual([]);
            expect(persistenceBoundary.readStoredCredentials).not.toHaveBeenCalled();
            expect(activeAccountBoundary.readSnapshot).not.toHaveBeenCalled();
            expect(activeAccountBoundary.readLifetime).not.toHaveBeenCalled();
            expect(activeAccountBoundary.subscribe).not.toHaveBeenCalled();
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
