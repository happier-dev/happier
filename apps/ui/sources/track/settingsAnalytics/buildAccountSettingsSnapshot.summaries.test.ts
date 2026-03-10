import { describe, expect, it } from 'vitest';
import { DEFAULT_ACTIONS_SETTINGS_V1 } from '@happier-dev/protocol';

import { settingsDefaults } from '@/sync/domains/settings/settings';

import { buildAccountSettingsSnapshot } from './buildAccountSettingsSnapshot';
import { buildAnalyticsProfile, buildEncryptedSecretValue, buildSecretValue } from './settingsAnalytics.testkit';

describe('buildAccountSettingsSnapshot', () => {
    it('tracks count-only collection summaries through canonical analytics serializers', () => {
        const snapshot = buildAccountSettingsSnapshot({
            ...settingsDefaults,
            recentMachinePaths: [
                { machineId: 'm1', path: '/repo-one' },
                { machineId: 'm2', path: '/repo-two' },
            ],
            favoriteDirectories: ['/a', '/b', '/c'],
            favoriteMachines: ['m1'],
            favoriteProfiles: ['default', 'custom:work'],
            pinnedSessionKeysV1: ['srv1:s1', 'srv2:s2'],
            workspaceLabelsV1: { wl_one: 'Alpha', wl_two: 'Beta' },
            collapsedGroupKeysV1: { g1: true, g2: true, g3: false },
            sessionTagsV1: {
                'srv1:s1': ['bug', 'urgent'],
                'srv2:s2': ['followup'],
            },
            sessionListGroupOrderV1: {
                groupA: ['srv1:s1', 'srv1:s2'],
                groupB: ['srv2:s1'],
            },
        });

        expect(snapshot.properties.acct_setting__recentMachinePaths).toBe(2);
        expect(snapshot.properties.acct_setting__favoriteDirectories).toBe(3);
        expect(snapshot.properties.acct_setting__favoriteMachines).toBe(1);
        expect(snapshot.properties.acct_setting__favoriteProfiles).toBe(2);
        expect(snapshot.properties.acct_setting__pinnedSessionKeysV1).toBe(2);
        expect(snapshot.properties.acct_setting__workspaceLabelsV1).toBe(2);
        expect(snapshot.properties.acct_setting__collapsedGroupKeysV1).toBe(3);
        expect(snapshot.properties.acct_setting__sessionTagsV1__taggedSessionCount).toBe(2);
        expect(snapshot.properties.acct_setting__sessionTagsV1__totalTagsCount).toBe(3);
        expect(snapshot.properties.acct_setting__sessionListGroupOrderV1__groupOverrideCount).toBe(2);
        expect(snapshot.properties.acct_setting__sessionListGroupOrderV1__totalOrderedKeyCount).toBe(3);
    });

    it('tracks dismissed cli warnings through canonical analytics serializers', () => {
        const snapshot = buildAccountSettingsSnapshot({
            ...settingsDefaults,
            dismissedCLIWarnings: {
                global: {
                    upgrade: true,
                    reconnect: true,
                },
                perMachine: {
                    machine_a: {
                        install: true,
                        auth: true,
                    },
                    machine_b: {
                        install: true,
                    },
                },
            },
        });

        expect(snapshot.properties.acct_setting__dismissedCLIWarnings__globalDismissedCount).toBe(2);
        expect(snapshot.properties.acct_setting__dismissedCLIWarnings__perMachineDismissedCount).toBe(3);
    });

    it('tracks connected services summaries through canonical analytics serializers', () => {
        const snapshot = buildAccountSettingsSnapshot({
            ...settingsDefaults,
            connectedServicesDefaultProfileByServiceId: {
                anthropic: 'work',
                'openai-codex': 'personal',
            },
            connectedServicesProfileLabelByKey: {
                'anthropic/work': 'Team',
                'openai-codex/personal': 'Personal',
                'openai-codex/work': 'Ops',
            },
            connectedServicesQuotaPinnedMeterIdsByKey: {
                'anthropic/work': ['weekly', 'monthly'],
                'openai-codex/personal': ['tokens'],
            },
            connectedServicesQuotaSummaryStrategyByKey: {
                'anthropic/work': 'primary',
                'openai-codex/personal': 'min_remaining',
                'openai-codex/work': 'primary',
            },
        });

        expect(snapshot.properties.acct_setting__connectedServicesDefaultProfileByServiceId).toBe(2);
        expect(snapshot.properties.acct_setting__connectedServicesProfileLabelByKey).toBe(3);
        expect(snapshot.properties.acct_setting__connectedServicesQuotaPinnedMeterIdsByKey__profilesWithPinsCount).toBe(2);
        expect(snapshot.properties.acct_setting__connectedServicesQuotaPinnedMeterIdsByKey__totalPinnedMeterCount).toBe(3);
        expect(snapshot.properties.acct_setting__connectedServicesQuotaSummaryStrategyByKey__primaryCount).toBe(2);
        expect(snapshot.properties.acct_setting__connectedServicesQuotaSummaryStrategyByKey__minRemainingCount).toBe(1);
    });

    it('tracks server selection group summaries through canonical analytics serializers', () => {
        const snapshot = buildAccountSettingsSnapshot({
            ...settingsDefaults,
            serverSelectionGroups: [
                {
                    id: 'grp-dev',
                    name: 'Dev',
                    serverIds: ['srv-a', 'srv-b'],
                    presentation: 'grouped',
                },
                {
                    id: 'grp-ops',
                    name: 'Ops',
                    serverIds: ['srv-c'],
                    presentation: 'flat-with-badge',
                },
            ],
        });

        expect(snapshot.properties.acct_setting__serverSelectionGroups__groupCount).toBe(2);
        expect(snapshot.properties.acct_setting__serverSelectionGroups__totalServerRefCount).toBe(3);
        expect(snapshot.properties.acct_setting__serverSelectionGroups__groupedCount).toBe(1);
        expect(snapshot.properties.acct_setting__serverSelectionGroups__flatWithBadgeCount).toBe(1);
    });

    it('tracks actions settings summaries through canonical analytics serializers', () => {
        const snapshot = buildAccountSettingsSnapshot({
            ...settingsDefaults,
            actionsSettingsV1: {
                ...DEFAULT_ACTIONS_SETTINGS_V1,
                actions: {
                    ...DEFAULT_ACTIONS_SETTINGS_V1.actions,
                    'review.start': {
                        enabled: false,
                        enabledPlacements: [],
                        disabledSurfaces: ['mcp'],
                        disabledPlacements: ['command_palette'],
                    },
                    'subagents.delegate.start': {
                        enabledPlacements: ['agent_input_chips'],
                        disabledSurfaces: ['voice_tool'],
                        disabledPlacements: [],
                    },
                    'subagents.plan.start': {
                        enabled: true,
                        enabledPlacements: [],
                        disabledSurfaces: [],
                        disabledPlacements: ['command_palette', 'session_header'],
                    },
                },
            },
        });

        expect(snapshot.properties.acct_setting__actionsSettingsV1__overrideCount).toBe(3);
        expect(snapshot.properties.acct_setting__actionsSettingsV1__enabledOverrideCount).toBe(2);
        expect(snapshot.properties.acct_setting__actionsSettingsV1__enabledPlacementCount).toBe(1);
        expect(snapshot.properties.acct_setting__actionsSettingsV1__disabledSurfaceCount).toBe(2);
        expect(snapshot.properties.acct_setting__actionsSettingsV1__disabledPlacementCount).toBe(3);
    });

    it('tracks prompt library and context selection summaries through canonical analytics serializers', () => {
        const snapshot = buildAccountSettingsSnapshot({
            ...settingsDefaults,
            promptStacksV1: {
                v: 1,
                surfaces: {
                    coding: [
                        { id: 'c1', ref: { kind: 'doc', artifactId: 'a1' }, enabled: true, placement: 'system_append', editPolicy: 'user_only' },
                        { id: 'c2', ref: { kind: 'doc', artifactId: 'a2' }, enabled: true, placement: 'system_append', editPolicy: 'user_only' },
                    ],
                    voice: [
                        { id: 'v1', ref: { kind: 'doc', artifactId: 'a3' }, enabled: true, placement: 'system_append', editPolicy: 'user_only' },
                    ],
                    profilesById: {
                        work: [
                            { id: 'p1', ref: { kind: 'doc', artifactId: 'a4' }, enabled: true, placement: 'system_append', editPolicy: 'user_only' },
                        ],
                        personal: [
                            { id: 'p2', ref: { kind: 'doc', artifactId: 'a5' }, enabled: true, placement: 'system_append', editPolicy: 'user_only' },
                        ],
                    },
                },
            },
            promptFoldersV1: {
                v: 1,
                folders: [
                    { id: 'f1', name: 'Work' },
                    { id: 'f2', name: 'Personal' },
                ],
            },
            promptInvocationsV1: {
                v: 1,
                entries: [
                    { id: 'i1', token: '/review', title: 'Review', target: { kind: 'doc', artifactId: 'a1' }, behavior: 'insert', allowArgs: false, availableIn: 'global' },
                    { id: 'i2', token: '/plan', title: 'Plan', target: { kind: 'doc', artifactId: 'a2' }, behavior: 'insert_and_send', allowArgs: true, availableIn: 'session_only' },
                ],
            },
            promptExternalLinksV1: {
                v: 1,
                links: [
                    { id: 'l1', artifactId: 'a1', assetTypeId: 'claude.command', scope: 'project', machineId: 'm1', externalRef: { relativePath: 'review/code.md' } },
                ],
            },
            promptRegistrySourcesV1: {
                v: 1,
                sources: [
                    { id: 's1', adapterId: 'git', title: 'Repo 1', enabled: true, config: { repositoryUrl: 'file:///repo-1' } },
                    { id: 's2', adapterId: 'git', title: 'Repo 2', enabled: false, config: { repositoryUrl: 'file:///repo-2' } },
                ],
            },
            contextSelectionsV1: {
                v: 1,
                selectionsByKey: {
                    one: { machineId: 'm1', workspacePath: '/repo-one' },
                    two: { machineId: 'm2', workspacePath: '/repo-two' },
                    three: { machineId: null, workspacePath: '/repo-three' },
                },
            },
        });

        expect(snapshot.properties.acct_setting__promptStacksV1__codingCount).toBe(2);
        expect(snapshot.properties.acct_setting__promptStacksV1__voiceCount).toBe(1);
        expect(snapshot.properties.acct_setting__promptStacksV1__profileOverrideCount).toBe(2);
        expect(snapshot.properties.acct_setting__promptFoldersV1).toBe(2);
        expect(snapshot.properties.acct_setting__promptInvocationsV1).toBe(2);
        expect(snapshot.properties.acct_setting__promptExternalLinksV1).toBe(1);
        expect(snapshot.properties.acct_setting__promptRegistrySourcesV1).toBe(2);
        expect(snapshot.properties.acct_setting__contextSelectionsV1).toBe(3);
    });

    it('tracks execution guidance, tmux overrides, and installables policy summaries through canonical analytics serializers', () => {
        const snapshot = buildAccountSettingsSnapshot({
            ...settingsDefaults,
            executionRunsGuidanceEntries: [
                {
                    id: 'guide-1',
                    description: 'Prefer Claude for UI work',
                    enabled: true,
                    suggestedBackendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                    suggestedModelId: 'claude-sonnet-4-5',
                    suggestedIntent: 'delegate',
                },
                {
                    id: 'guide-2',
                    description: 'Use Codex for review-only runs',
                    enabled: false,
                    suggestedBackendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                    suggestedIntent: 'review',
                },
                {
                    id: 'guide-3',
                    description: 'Plan first when unsure',
                    enabled: true,
                    suggestedIntent: 'plan',
                },
            ],
            sessionTmuxByMachineId: {
                machine_a: {
                    useTmux: true,
                    sessionName: 'happy-a',
                    isolated: true,
                    tmpDir: '/tmp/a',
                },
                machine_b: {
                    useTmux: false,
                    sessionName: 'happy-b',
                    isolated: false,
                    tmpDir: null,
                },
            },
            installablesPolicyByMachineId: {
                machine_a: {
                    claude: {
                        autoInstallWhenNeeded: true,
                        autoUpdateMode: 'auto',
                    },
                    codex: {
                        autoInstallWhenNeeded: false,
                        autoUpdateMode: 'notify',
                    },
                },
                machine_b: {
                    gemini: {
                        autoInstallWhenNeeded: true,
                        autoUpdateMode: 'off',
                    },
                },
            },
        });

        expect(snapshot.properties.acct_setting__executionRunsGuidanceEntries__totalCount).toBe(3);
        expect(snapshot.properties.acct_setting__executionRunsGuidanceEntries__enabledCount).toBe(2);
        expect(snapshot.properties.acct_setting__executionRunsGuidanceEntries__withSuggestedBackendCount).toBe(2);
        expect(snapshot.properties.acct_setting__executionRunsGuidanceEntries__withSuggestedModelCount).toBe(1);
        expect(snapshot.properties.acct_setting__executionRunsGuidanceEntries__delegateCount).toBe(1);
        expect(snapshot.properties.acct_setting__executionRunsGuidanceEntries__reviewCount).toBe(1);
        expect(snapshot.properties.acct_setting__executionRunsGuidanceEntries__planCount).toBe(1);
        expect(snapshot.properties.acct_setting__sessionTmuxByMachineId__overrideCount).toBe(2);
        expect(snapshot.properties.acct_setting__sessionTmuxByMachineId__useTmuxCount).toBe(1);
        expect(snapshot.properties.acct_setting__sessionTmuxByMachineId__isolatedCount).toBe(1);
        expect(snapshot.properties.acct_setting__sessionTmuxByMachineId__customTmpDirCount).toBe(1);
        expect(snapshot.properties.acct_setting__installablesPolicyByMachineId__machineCount).toBe(2);
        expect(snapshot.properties.acct_setting__installablesPolicyByMachineId__totalInstallableOverrideCount).toBe(3);
        expect(snapshot.properties.acct_setting__installablesPolicyByMachineId__autoInstallOverrideCount).toBe(2);
        expect(snapshot.properties.acct_setting__installablesPolicyByMachineId__autoUpdateAutoCount).toBe(1);
        expect(snapshot.properties.acct_setting__installablesPolicyByMachineId__autoUpdateNotifyCount).toBe(1);
        expect(snapshot.properties.acct_setting__installablesPolicyByMachineId__autoUpdateOffCount).toBe(1);
    });

    it('tracks profile, secret, and mcp summaries through canonical analytics serializers', () => {
        const snapshot = buildAccountSettingsSnapshot({
            ...settingsDefaults,
            profiles: [
                buildAnalyticsProfile({
                    id: 'builtin-claude',
                    name: 'Claude',
                    isBuiltIn: true,
                }),
                buildAnalyticsProfile({
                    id: 'work',
                    name: 'Work',
                    environmentVariables: [
                        { name: 'API_BASE', value: 'https://example.com' },
                        { name: 'OPENAI_API_KEY', value: '${WORK_KEY}', isSecret: true },
                    ],
                    authMode: 'machineLogin',
                    requiresMachineLogin: 'codex',
                    envVarRequirements: [{ name: 'OPENAI_API_KEY', kind: 'secret', required: true }],
                }),
            ],
            lastUsedProfile: 'work',
            secrets: [
                {
                    id: 'secret-1',
                    name: 'Work Key',
                    kind: 'apiKey',
                    encryptedValue: buildSecretValue('sk-work'),
                    createdAt: 1,
                    updatedAt: 1,
                },
                {
                    id: 'secret-2',
                    name: 'Service Token',
                    kind: 'token',
                    encryptedValue: buildEncryptedSecretValue('ciphertext'),
                    createdAt: 2,
                    updatedAt: 2,
                },
            ],
            secretBindingsByProfileId: {
                work: {
                    OPENAI_API_KEY: 'secret-1',
                    SERVICE_TOKEN: 'secret-2',
                },
                'builtin-claude': {
                    CLAUDE_API_KEY: 'secret-1',
                },
            },
            mcpServersSettingsV1: {
                v: 1,
                strictMode: true,
                servers: [
                    {
                        id: 'srv-stdio',
                        name: 'local_stdio',
                        transport: 'stdio',
                        stdio: { command: 'uvx', args: ['server'] },
                        env: {
                            API_KEY: { t: 'savedSecret', secretId: 'secret-1' },
                        },
                        createdAt: 1,
                        updatedAt: 1,
                    },
                    {
                        id: 'srv-http',
                        name: 'remote_http',
                        transport: 'http',
                        remote: {
                            url: 'https://example.com/mcp',
                            headers: {
                                Authorization: { t: 'savedSecret', secretId: 'secret-2' },
                            },
                        },
                        env: {},
                        createdAt: 2,
                        updatedAt: 2,
                    },
                ],
                bindings: [
                    {
                        id: 'bind-all',
                        serverId: 'srv-stdio',
                        enabled: true,
                        target: { t: 'allMachines' },
                        createdAt: 1,
                        updatedAt: 1,
                    },
                    {
                        id: 'bind-machine',
                        serverId: 'srv-http',
                        enabled: false,
                        target: { t: 'machine', machineId: 'machine-a' },
                        overrides: {
                            envPatch: {
                                API_TOKEN: { t: 'savedSecret', secretId: 'secret-2' },
                            },
                        },
                        createdAt: 2,
                        updatedAt: 2,
                    },
                    {
                        id: 'bind-workspace',
                        serverId: 'srv-http',
                        enabled: true,
                        target: { t: 'workspace', machineId: 'machine-b', workspaceRoot: '/repo' },
                        overrides: {
                            remote: {
                                headersPatch: {
                                    Authorization: { t: 'savedSecret', secretId: 'secret-1' },
                                },
                            },
                        },
                        createdAt: 3,
                        updatedAt: 3,
                    },
                ],
            },
        });

        expect(snapshot.properties.acct_setting__profiles__totalCount).toBe(2);
        expect(snapshot.properties.acct_setting__profiles__customEnvVarProfileCount).toBe(1);
        expect(snapshot.properties.acct_setting__profiles__builtInCount).toBe(1);
        expect(snapshot.properties.acct_setting__profiles__machineLoginCount).toBe(1);
        expect(snapshot.properties.acct_setting__lastUsedProfile).toBe('custom');
        expect(snapshot.properties.acct_setting__secrets).toBe(2);
        expect(snapshot.properties.acct_setting__secretBindingsByProfileId__boundProfileCount).toBe(2);
        expect(snapshot.properties.acct_setting__secretBindingsByProfileId__totalBindingCount).toBe(3);
        expect(snapshot.properties.acct_setting__mcpServersSettingsV1__strictMode).toBe(true);
        expect(snapshot.properties.acct_setting__mcpServersSettingsV1__serverCount).toBe(2);
        expect(snapshot.properties.acct_setting__mcpServersSettingsV1__stdioCount).toBe(1);
        expect(snapshot.properties.acct_setting__mcpServersSettingsV1__httpCount).toBe(1);
        expect(snapshot.properties.acct_setting__mcpServersSettingsV1__sseCount).toBe(0);
        expect(snapshot.properties.acct_setting__mcpServersSettingsV1__bindingCount).toBe(3);
        expect(snapshot.properties.acct_setting__mcpServersSettingsV1__enabledBindingCount).toBe(2);
        expect(snapshot.properties.acct_setting__mcpServersSettingsV1__allMachinesCount).toBe(1);
        expect(snapshot.properties.acct_setting__mcpServersSettingsV1__machineTargetCount).toBe(1);
        expect(snapshot.properties.acct_setting__mcpServersSettingsV1__workspaceTargetCount).toBe(1);
        expect(snapshot.properties.acct_setting__mcpServersSettingsV1__overridePresenceCount).toBe(2);
        expect(snapshot.properties.acct_setting__mcpServersSettingsV1__savedSecretRefCount).toBe(4);
    });
});

