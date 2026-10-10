import { afterEach, describe, expect, it, vi } from 'vitest';

// Localization is a platform boundary; the descriptor interpreter remains real.
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

import {
    canSelectAgentWithoutDetectedCli,
    buildSpawnSessionExtrasFromUiState,
    getAgentResumeExperimentsFromSettings,
    resolveAgentUiBehavior,
    resolveAgentUiBehaviorFromSessionMetadata,
} from './registryUiBehavior';
import {
    clearProjectedAgentUiBehaviorDescriptors,
    publishProjectedAgentUiBehaviorDescriptors,
    readProjectedAgentUiBehaviorDiagnostics,
} from './agentUiBehaviorProjection';
import { makeSettings } from './registryUiBehavior.testHelpers';
import { attachAgentPluginSettings } from './agentUiSettingLookup';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { createSessionFixture } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

installDisconnectedServerSocketBoundary();
const accountConnections: Awaited<ReturnType<typeof restoreServerAccountForTest>>[] = [];

const EXTERNAL_AGENT_ID = 'acme.agent';

function supportsStorageMode(agentId: string, storageMode: 'persisted' | 'direct'): boolean {
    const supports = resolveAgentUiBehavior(agentId).newSession?.supportsTranscriptStorageMode;
    return supports?.({ agentId, settings: makeSettings(), storageMode }) === true;
}

/**
 * Drives the canonical active-scope owner through its own production seams
 * (Account restore through the disconnected transport boundary) rather than
 * mocking it: the Account fence under test IS that owner's answer.
 */
async function activateServerAccount(serverUrl: string, accountId: string, serverIdentityId?: string) {
    await loadSyncSingletonForTests();
    // The harness uses the app's cold restore. A second cold restore on an
    // initialized Sync is intentionally ignored; retire its real connection
    // before restoring the next Account instead of faking active scope state.
    if (accountConnections.length > 0) {
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await disconnectActiveServerConnection();
    }
    const connection = await restoreServerAccountForTest({ serverUrl, accountId, serverIdentityId });
    accountConnections.push(connection);
    const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
    expect(getActiveServerAccountScope()?.accountId).toBe(accountId);
    return connection.home;
}

function footerDescriptor(usePermissionUpdates: boolean): Readonly<Record<string, unknown>> {
    return { permissions: { footer: { usePermissionUpdates } } };
}

/**
 * Session metadata exactly as the canonical identity reader consumes it.
 *
 * A bare top-level `agentId` is NOT an Agent declaration:
 * `resolveSessionMetadataAgentIdentity` reads `runtimeDescriptorV1`, a linked
 * external session, or `flavor`, and `RuntimeDescriptorV1Schema` requires
 * `{ v, agentId, agent }`. A fixture missing either would resolve to a null
 * Agent identity, and every machine assertion below would then be answered by
 * that null instead of by the machine fence under test.
 */
function sessionOnMachine(machineId: string): Readonly<Record<string, unknown>> {
    return {
        machineId,
        path: '',
        host: '',
        runtimeDescriptorV1: { v: 1, agentId: EXTERNAL_AGENT_ID, agent: {} },
    };
}

describe('daemon-projected agent UI behavior descriptors', () => {
    afterEach(async () => {
        clearProjectedAgentUiBehaviorDescriptors();
        for (const connection of accountConnections.splice(0).reverse()) await connection.dispose();
    });

    it('launches with the selected portable Home override instead of its legacy routing key or active Home', async () => {
        const active = await activateServerAccount('https://opencode-active.example.test', 'account-a', 'srv_opencode_active');
        const { upsertServerProfileOnly } = await import('@/sync/domains/server/serverRuntime');
        const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
        const selectedProfile = await upsertServerProfileOnly({ serverUrl: 'https://opencode-selected.example.test', name: 'Selected Home' });
        const selected = await setServerProfileIdentityForUrl(selectedProfile.serverUrl, 'srv_opencode_selected');
        if (!selected) throw new Error('Selected test Home identity could not be established');
        expect(selected.id).not.toBe(selected.serverIdentityId);
        expect(active.id).not.toBe(active.serverIdentityId);
        const settings = attachAgentPluginSettings(makeSettings(), { account: {
            opencodeBackendMode: 'server',
            opencodeServerBaseUrlByServerIdV1: {
                'srv_opencode_selected': 'https://selected-opencode.example.test/path',
                [selected.id]: 'https://legacy-opencode.example.test/',
                'srv_opencode_active': 'https://active-opencode.example.test/',
            },
        } });
        expect(buildSpawnSessionExtrasFromUiState({
            agentId: 'opencode', settings, resumeSessionId: '', updatedAt: 123,
            newSessionOptions: { targetServerId: selected.id },
        }).sessionConfigOptionOverrides?.overrides.opencodeServerBaseUrl)
            .toEqual({ value: 'https://selected-opencode.example.test/', updatedAt: 123 });
        expect(buildSpawnSessionExtrasFromUiState({
            agentId: 'opencode', settings, resumeSessionId: '', updatedAt: 123,
        }).sessionConfigOptionOverrides?.overrides.opencodeServerBaseUrl)
            .toEqual({ value: 'https://active-opencode.example.test/', updatedAt: 123 });
        expect(buildSpawnSessionExtrasFromUiState({
            agentId: 'opencode', settings, resumeSessionId: '', updatedAt: 123,
            newSessionOptions: { targetServerId: 'missing-routing-profile' },
        }).sessionConfigOptionOverrides?.overrides).not.toHaveProperty('opencodeServerBaseUrl');
    });

    it('retains the actual predecessor routing-key Account carrier when no portable override exists', async () => {
        const home = await activateServerAccount('https://opencode-predecessor.example.test', 'account-a', 'srv_opencode_predecessor');
        // ../0.2 at f2dd8f01185784676b639cec5cf8a5ed79973301 writes this flat
        // Account map through providerSettingsFieldBinding using snapshot.serverId.
        const settings = makeSettings({
            opencodeBackendMode: 'server',
            opencodeServerBaseUrlByServerIdV1: { [home.id]: 'https://predecessor-opencode.example.test/path' },
        });
        expect(buildSpawnSessionExtrasFromUiState({
            agentId: 'opencode', settings, resumeSessionId: '', updatedAt: 123,
            newSessionOptions: { targetServerId: home.id },
        }).sessionConfigOptionOverrides?.overrides.opencodeServerBaseUrl)
            .toEqual({ value: 'https://predecessor-opencode.example.test/', updatedAt: 123 });
    });

    it.each(['', 'https://user:password@remote-opencode.example.test/'])('does not revive a legacy routing URL behind a present rejected portable override (%s)', async (portableValue) => {
        const home = await activateServerAccount('https://opencode-rejected.example.test', 'account-a', 'srv_opencode_rejected');
        const settings = attachAgentPluginSettings(makeSettings(), { account: {
            opencodeBackendMode: 'server',
            opencodeServerBaseUrlByServerIdV1: {
                'srv_opencode_rejected': portableValue,
                [home.id]: 'https://legacy-opencode.example.test/',
            },
        } });
        expect(buildSpawnSessionExtrasFromUiState({
            agentId: 'opencode', settings, resumeSessionId: '', updatedAt: 123,
            newSessionOptions: { targetServerId: home.id },
        }).sessionConfigOptionOverrides?.overrides).not.toHaveProperty('opencodeServerBaseUrl');
    });

    it('exposes the parsed Agent-owned portable runtime choice without inventing presentation', () => {
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'machine-runtime',
            descriptorsByAgentId: {
                [EXTERNAL_AGENT_ID]: {
                    payload: {
                        environmentVariables: {
                            backendMode: {
                                envKey: 'ACME_BACKEND_MODE',
                                settingKey: { scope: 'account', localId: 'backendMode' },
                                defaultValue: 'server',
                                values: ['server', 'acp'],
                            },
                        },
                    },
                },
            },
        });

        expect(resolveAgentUiBehavior(EXTERNAL_AGENT_ID, 'machine-runtime').newSession?.runtimeDescriptorV1)
            .toEqual({
                backendMode: {
                    settingKey: { scope: 'account', localId: 'backendMode' },
                    values: ['server', 'acp'],
                },
            });
    });

    it('keeps opposing Stop policies isolated for two routed servers sharing a machine', async () => {
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        await activateServerAccount('https://behavior-b.example.test', 'account-b');
        const serverB = getActiveServerSnapshot().serverId;
        await activateServerAccount('https://behavior-a.example.test', 'account-a');
        const serverA = getActiveServerSnapshot().serverId;
        const { createServerAccountScope } = await import('@/sync/domains/scope/serverAccountScope');
        const scopeA = createServerAccountScope(serverA, 'account-a');
        const scopeB = createServerAccountScope(serverB, 'account-b');
        for (const [accountScope, stopHandling] of [
            [scopeA, 'denyAndAbortRun'],
            [scopeB, 'denyOnly'],
        ] as const) {
            publishProjectedAgentUiBehaviorDescriptors({
                accountScope,
                machineId: 'shared-machine',
                descriptorsByAgentId: {
                    [EXTERNAL_AGENT_ID]: { permissions: { footer: { stopHandling } } },
                },
            });
        }
        const metadata = sessionOnMachine('shared-machine');
        const behaviorA = resolveAgentUiBehaviorFromSessionMetadata(metadata, scopeA);
        const behaviorB = resolveAgentUiBehaviorFromSessionMetadata(metadata, scopeB);
        expect(behaviorA?.permissions?.footer?.stopHandling).toBe('denyAndAbortRun');
        expect(behaviorB?.permissions?.footer?.stopHandling).toBe('denyOnly');
        expect(resolveAgentUiBehaviorFromSessionMetadata(metadata, scopeA)).toBe(behaviorA);
    });

    it('rejects publication captured before the active Account lifetime retired', async () => {
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        await activateServerAccount('https://behavior-late.example.test', 'account-a');
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        await activateServerAccount('https://behavior-late.example.test', 'account-b');
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'shared-machine',
            accountLifetime,
            descriptorsByAgentId: {
                [EXTERNAL_AGENT_ID]: { permissions: { footer: { stopHandling: 'denyOnly' } } },
            },
        });
        expect(resolveAgentUiBehavior(EXTERNAL_AGENT_ID, 'shared-machine').permissions?.footer?.stopHandling)
            .toBe('denyAndAbortRun');
    });

    it('keys resume experiment reads to the exact machine declaration, never another machine', () => {
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'machine-b',
            descriptorsByAgentId: {
                [EXTERNAL_AGENT_ID]: {
                    resume: { experimentSwitches: [{ id: 'acpResume', settingKey: { scope: 'account', localId: 'codexAcpEnabled' } }] },
                },
            },
        });
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'machine-a',
            descriptorsByAgentId: {
                [EXTERNAL_AGENT_ID]: {
                    resume: { experimentSwitches: [{ id: 'legacyResume', settingKey: { scope: 'account', localId: 'agentResumePaneEnabled' } }] },
                },
            },
        });
        const settings = makeSettings();
        const pluginSettings = {
            account: { codexAcpEnabled: true, agentResumePaneEnabled: false },
        } as const;

        expect(getAgentResumeExperimentsFromSettings(EXTERNAL_AGENT_ID, settings, 'machine-a', pluginSettings)).toEqual({
            enabled: true,
            switches: { legacyResume: false },
        });
        expect(getAgentResumeExperimentsFromSettings(EXTERNAL_AGENT_ID, settings, 'machine-b', {
            account: { codexAcpEnabled: true },
        })).toEqual({
            enabled: true,
            switches: { acpResume: true },
        });
        // A machine that publishes nothing keeps the neutral floor instead of
        // adopting whichever machine sorts first.
        expect(getAgentResumeExperimentsFromSettings(EXTERNAL_AGENT_ID, settings, 'machine-c', pluginSettings)).toEqual({
            enabled: true,
            switches: {},
        });
    });

    it('resolves Account, Daemon, and host Agent setting refs without cross-scope key dedupe', () => {
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'machine-a',
            descriptorsByAgentId: {
                [EXTERNAL_AGENT_ID]: {
                    resume: {
                        experimentSwitches: [
                            { id: 'account', settingKey: { scope: 'account', localId: 'shared' } },
                            { id: 'daemon', settingKey: { scope: 'daemon', localId: 'shared' } },
                            { id: 'host', settingKey: { scope: 'host', localId: 'hostFlag' } },
                        ],
                    },
                },
            },
        });
        const settings = makeSettings({ shared: false, hostFlag: true });

        expect(getAgentResumeExperimentsFromSettings(EXTERNAL_AGENT_ID, settings, 'machine-a', {
            account: { shared: true },
            daemon: { shared: false },
        })).toEqual({
            enabled: true,
            switches: { account: true, daemon: false, host: true },
        });
    });

    it('resolves a projected descriptor for an external Agent instead of the unknown fallback', () => {
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'machine-a',
            descriptorsByAgentId: {
                [EXTERNAL_AGENT_ID]: {
                    kind: 'plugin.ui.v1',
                    pluginId: 'acme',
                    agentId: EXTERNAL_AGENT_ID,
                    version: 1,
                    behavior: {
                        permissions: {
                            footer: {
                                usePermissionUpdates: true,
                                forceReadOnlyAfterStop: false,
                                supportsExecPolicyAmendment: true,
                                stopHandling: 'denyOnly',
                            },
                        },
                        newSession: { transcriptStorageModes: ['persisted', 'direct'] },
                    },
                },
            },
        });

        const behavior = resolveAgentUiBehavior(EXTERNAL_AGENT_ID);

        expect(behavior.permissions?.footer).toEqual({
            usePermissionUpdates: true,
            forceReadOnlyAfterStop: false,
            supportsExecPolicyAmendment: true,
            stopHandling: 'denyOnly',
        });
        expect(supportsStorageMode(EXTERNAL_AGENT_ID, 'persisted')).toBe(true);
        expect(supportsStorageMode(EXTERNAL_AGENT_ID, 'direct')).toBe(true);
    });

    it('returns a referentially stable behavior while the descriptor stays published', () => {
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'machine-a',
            descriptorsByAgentId: {
                [EXTERNAL_AGENT_ID]: { permissions: { footer: { usePermissionUpdates: true } } },
            },
        });

        expect(resolveAgentUiBehavior(EXTERNAL_AGENT_ID)).toBe(resolveAgentUiBehavior(EXTERNAL_AGENT_ID));
    });

    it('resolves teammate details labels from the owning plugin projection locale', () => {
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'machine-a',
            locale: 'es',
            pluginUiProjection: {
                ...EMPTY_PLUGIN_UI_PROJECTION,
                translationsByPluginId: {
                    acme: {
                        id: 'translations:acme',
                        pluginId: 'acme',
                        contributionKind: 'translations',
                        locales: ['en', 'es'],
                        bundles: {
                            en: { 'acme.subagents.launch.title': 'Launch teammate' },
                            es: { 'acme.subagents.launch.title': 'Iniciar compañero' },
                        },
                    },
                },
            },
            descriptorsByAgentId: {
                [EXTERNAL_AGENT_ID]: {
                    kind: 'plugin.ui.v1',
                    pluginId: 'acme',
                    agentId: EXTERNAL_AGENT_ID,
                    version: 1,
                    components: {
                        slots: [{
                            id: 'acme.details',
                            slot: 'sessionSubagents.teammateDetailsTab',
                            surfaceId: 'subagent-details',
                            resourceKind: 'acmeSubagentLauncher',
                            iconName: 'users',
                            tab: {
                                keyPrefix: 'acme-subagent-launcher',
                                titleKey: 'acme.subagents.launch.title',
                            },
                        }],
                    },
                },
            },
        });

        expect(resolveAgentUiBehavior(EXTERNAL_AGENT_ID, 'machine-a')
            .sessionSubagents?.createTeammateLauncherDetailsTab?.({
                session: createSessionFixture(),
                teamId: 'team-1',
            })?.title).toBe('Iniciar compañero');
    });

    it('keeps the unknown fallback for an external Agent that ships no descriptor', () => {
        const behavior = resolveAgentUiBehavior('acme.undeclared');

        expect(behavior.permissions?.footer).toEqual({
            usePermissionUpdates: false,
            forceReadOnlyAfterStop: true,
            supportsExecPolicyAmendment: false,
            stopHandling: 'denyAndAbortRun',
        });
        expect(supportsStorageMode('acme.undeclared', 'persisted')).toBe(false);
    });

    it('uses the exact machine projection for a bundled Agent without changing its machine-blind floor', () => {
        const before = resolveAgentUiBehavior('claude');

        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'machine-a',
            descriptorsByAgentId: {
                claude: { permissions: { footer: { usePermissionUpdates: false, stopHandling: 'denyOnly' } } },
            },
        });

        expect(resolveAgentUiBehavior('claude')).toBe(before);
        expect(resolveAgentUiBehavior('claude', 'machine-a')).not.toBe(before);
        expect(resolveAgentUiBehavior('claude', 'machine-a').permissions?.footer?.stopHandling)
            .toBe('denyOnly');
        expect(resolveAgentUiBehavior('claude', 'machine-b')).toBe(before);
    });

    it('resolves a Session against ITS machine, never another machine that also ships the Agent', async () => {
        await activateServerAccount('https://scoped.example.test', 'account-1');
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'machine-a',
            descriptorsByAgentId: { [EXTERNAL_AGENT_ID]: footerDescriptor(true) },
        });
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'machine-b',
            descriptorsByAgentId: { [EXTERNAL_AGENT_ID]: footerDescriptor(false) },
        });

        const sessionOnB = sessionOnMachine('machine-b');
        const sessionOnA = sessionOnMachine('machine-a');

        // Lexicographically lowest machine id is 'machine-a'. A machine-blind
        // resolution would hand machine-a's declaration to a Session that runs
        // on machine-b.
        expect(resolveAgentUiBehaviorFromSessionMetadata(sessionOnB)?.permissions?.footer?.usePermissionUpdates)
            .toBe(false);
        expect(resolveAgentUiBehaviorFromSessionMetadata(sessionOnA)?.permissions?.footer?.usePermissionUpdates)
            .toBe(true);
    });

    it('uses the exact machine declaration for installed Agent CLI-less selectability', () => {
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'machine-a',
            descriptorsByAgentId: {
                [EXTERNAL_AGENT_ID]: { newSession: { canSelectWithoutDetectedCli: true } },
            },
        });
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'machine-b',
            descriptorsByAgentId: {
                [EXTERNAL_AGENT_ID]: { newSession: { canSelectWithoutDetectedCli: false } },
            },
        });

        expect(canSelectAgentWithoutDetectedCli({
            agentId: EXTERNAL_AGENT_ID,
            machineId: 'machine-a',
            settings: makeSettings(),
        })).toBe(true);
        expect(canSelectAgentWithoutDetectedCli({
            agentId: EXTERNAL_AGENT_ID,
            machineId: 'machine-b',
            settings: makeSettings(),
        })).toBe(false);
    });

    it('falls to the neutral floor rather than another machine when the owning machine ships none', async () => {
        await activateServerAccount('https://scoped.example.test', 'account-1');
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'machine-a',
            descriptorsByAgentId: { [EXTERNAL_AGENT_ID]: footerDescriptor(true) },
        });

        const sessionOnB = sessionOnMachine('machine-b');

        expect(resolveAgentUiBehaviorFromSessionMetadata(sessionOnB)?.permissions?.footer?.usePermissionUpdates)
            .toBe(false);
    });

    it('keeps same-machine declarations separate across concurrent Home Accounts', async () => {
        await activateServerAccount('https://active.example.test', 'account-a');
        const homeA = { serverId: 'home-a', accountId: 'account-a' };
        const homeB = { serverId: 'home-b', accountId: 'account-b' };
        publishProjectedAgentUiBehaviorDescriptors({
            accountScope: homeA,
            machineId: 'shared-machine',
            descriptorsByAgentId: { [EXTERNAL_AGENT_ID]: footerDescriptor(true) },
        });
        publishProjectedAgentUiBehaviorDescriptors({
            accountScope: homeB,
            machineId: 'shared-machine',
            descriptorsByAgentId: { [EXTERNAL_AGENT_ID]: footerDescriptor(false) },
        });
        expect(resolveAgentUiBehavior(EXTERNAL_AGENT_ID, 'shared-machine', homeA)
            .permissions?.footer?.usePermissionUpdates).toBe(true);
        expect(resolveAgentUiBehavior(EXTERNAL_AGENT_ID, 'shared-machine', homeB)
            .permissions?.footer?.usePermissionUpdates).toBe(false);
        expect(resolveAgentUiBehavior(EXTERNAL_AGENT_ID, 'shared-machine', {
            ...homeA, accountId: 'replacement-account',
        }).permissions?.footer?.usePermissionUpdates).toBe(false);
        expect(resolveAgentUiBehavior(EXTERNAL_AGENT_ID, 'shared-machine', null)
            .permissions?.footer?.usePermissionUpdates).toBe(false);
        publishProjectedAgentUiBehaviorDescriptors({
            accountScope: homeB, machineId: 'shared-machine', descriptorsByAgentId: {},
        });
        expect(resolveAgentUiBehavior(EXTERNAL_AGENT_ID, 'shared-machine', homeA)
            .permissions?.footer?.usePermissionUpdates).toBe(true);
    });

    it('never reads a descriptor published under a retired Account', async () => {
        await activateServerAccount('https://scoped.example.test', 'account-1');
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'machine-a',
            descriptorsByAgentId: { [EXTERNAL_AGENT_ID]: footerDescriptor(true) },
        });
        expect(resolveAgentUiBehavior(EXTERNAL_AGENT_ID, 'machine-a').permissions?.footer?.usePermissionUpdates)
            .toBe(true);

        await activateServerAccount('https://scoped.example.test', 'account-2');

        // The store is a module global with no Account key of its own before
        // this fence: account-2 would inherit account-1's Agent declarations.
        expect(resolveAgentUiBehavior(EXTERNAL_AGENT_ID, 'machine-a').permissions?.footer?.usePermissionUpdates)
            .toBe(false);
        expect(resolveAgentUiBehavior(EXTERNAL_AGENT_ID).permissions?.footer?.usePermissionUpdates).toBe(false);
    });

    it('reports the interpreter refusals an external descriptor produced, per machine', async () => {
        await activateServerAccount('https://scoped.example.test', 'account-1');
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'machine-a',
            descriptorsByAgentId: {
                [EXTERNAL_AGENT_ID]: {
                    payload: { spawnSessionExtras: { kind: 'adapter', adapterId: 'acme.custom' } },
                },
            },
        });

        const diagnostics = readProjectedAgentUiBehaviorDiagnostics('machine-a');

        expect(diagnostics.length).toBeGreaterThan(0);
        expect(diagnostics[0]).toMatchObject({
            agentId: EXTERNAL_AGENT_ID,
            code: 'A16X1_UNSUPPORTED_DESCRIPTOR_ADAPTER',
        });
        // A machine that published nothing reports nothing, so a per-machine
        // Settings screen never shows another machine's author feedback.
        expect(readProjectedAgentUiBehaviorDiagnostics('machine-b')).toEqual([]);
    });

    it('retires a machine descriptor set when that machine republishes without it', () => {
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'machine-a',
            descriptorsByAgentId: {
                [EXTERNAL_AGENT_ID]: { permissions: { footer: { usePermissionUpdates: true } } },
            },
        });
        expect(resolveAgentUiBehavior(EXTERNAL_AGENT_ID).permissions?.footer?.usePermissionUpdates).toBe(true);

        publishProjectedAgentUiBehaviorDescriptors({ machineId: 'machine-a', descriptorsByAgentId: {} });

        expect(resolveAgentUiBehavior(EXTERNAL_AGENT_ID).permissions?.footer?.usePermissionUpdates).toBe(false);
    });
});
