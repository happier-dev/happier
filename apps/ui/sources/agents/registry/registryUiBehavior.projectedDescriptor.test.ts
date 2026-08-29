import { afterEach, describe, expect, it } from 'vitest';

import {
    canSelectAgentWithoutDetectedCli,
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
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { createSessionFixture } from '@/dev/testkit';

const EXTERNAL_AGENT_ID = 'acme.agent';

function supportsStorageMode(agentId: string, storageMode: 'persisted' | 'direct'): boolean {
    const supports = resolveAgentUiBehavior(agentId).newSession?.supportsTranscriptStorageMode;
    return supports?.({ agentId, settings: makeSettings(), storageMode }) === true;
}

/**
 * Drives the canonical active-scope owner through its own production seams
 * (server activation plus the registered storage-state reader) rather than
 * mocking it: the Account fence under test IS that owner's answer.
 */
async function activateServerAccount(serverUrl: string, accountId: string): Promise<void> {
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    const { createServerAccountScope } = await import('@/sync/domains/scope/serverAccountScope');
    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
    const server = upsertAndActivateServer({
        serverUrl,
        source: 'manual',
        scope: 'device',
        replaceEquivalentStoredUrl: true,
    });
    const scope = createServerAccountScope(server.id, accountId);
    expect(scope).not.toBeNull();
    registerStorageStateReader(() => ({ profileScope: scope } as never));
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
    afterEach(() => {
        clearProjectedAgentUiBehaviorDescriptors();
    });

    it('keys resume experiment reads to the exact machine declaration, never another machine', () => {
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'machine-b',
            descriptorsByAgentId: {
                [EXTERNAL_AGENT_ID]: {
                    resume: { experimentSwitches: [{ id: 'acpResume', settingKey: 'codexAcpEnabled' }] },
                },
            },
        });
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'machine-a',
            descriptorsByAgentId: {
                [EXTERNAL_AGENT_ID]: {
                    resume: { experimentSwitches: [{ id: 'legacyResume', settingKey: 'agentResumePaneEnabled' }] },
                },
            },
        });
        const settings = makeSettings({ codexAcpEnabled: true, agentResumePaneEnabled: false });

        expect(getAgentResumeExperimentsFromSettings(EXTERNAL_AGENT_ID, settings, 'machine-a')).toEqual({
            enabled: true,
            switches: { legacyResume: false },
        });
        expect(getAgentResumeExperimentsFromSettings(EXTERNAL_AGENT_ID, settings, 'machine-b')).toEqual({
            enabled: true,
            switches: { acpResume: true },
        });
        // A machine that publishes nothing keeps the neutral floor instead of
        // adopting whichever machine sorts first.
        expect(getAgentResumeExperimentsFromSettings(EXTERNAL_AGENT_ID, settings, 'machine-c')).toEqual({
            enabled: true,
            switches: {},
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
