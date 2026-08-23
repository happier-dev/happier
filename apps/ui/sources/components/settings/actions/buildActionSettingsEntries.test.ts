import { describe, expect, it } from 'vitest';

import { ActionsSettingsV1Schema, DEFAULT_ACTIONS_SETTINGS_V1 } from '@happier-dev/protocol';

describe('buildActionSettingsEntries', () => {
    it('marks inventory voice surfaces unavailable when device inventory sharing is disabled', async () => {
        const { buildActionSettingsEntries } = await import('./buildActionSettingsEntries');

        const entries = buildActionSettingsEntries({
            query: '',
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            availability: {
                executionRunsEnabled: true,
                memorySearchEnabled: true,
                voiceEnabled: true,
                sessionHandoffEnabled: true,
                mcpServersEnabled: true,
                voiceShareDeviceInventory: false,
            },
        });

        expect(entries.some((entry) => entry.actionId === 'paths.list_recent')).toBe(true);

        const paths = entries.find((entry) => entry.actionId === 'paths.list_recent');
        expect(paths).toBeTruthy();

        const voicePanel = paths!.targets.find((target) => target.id === 'voice_panel');
        const voiceTool = paths!.targets.find((target) => target.id === 'voice');

        expect(voicePanel?.state).toBe('unavailable');
        expect(voicePanel?.reasonKey).toBe('settingsActions.reasons.voiceInventoryPrivacy');
        expect(voiceTool?.state).toBe('unavailable');
    });

    it('treats agent input chips as opt-in and MCP as off when explicitly disabled', async () => {
        const { buildActionSettingsEntries } = await import('./buildActionSettingsEntries');

        const entries = buildActionSettingsEntries({
            query: '',
            settings: ActionsSettingsV1Schema.parse({
                v: 1,
                actions: {
                    'review.start': {
                        enabledPlacements: ['agent_input_chips'],
                        disabledSurfaces: ['mcp'],
                        disabledPlacements: [],
                    },
                },
            }),
            availability: {
                executionRunsEnabled: true,
                memorySearchEnabled: true,
                voiceEnabled: true,
                sessionHandoffEnabled: true,
                mcpServersEnabled: true,
                voiceShareDeviceInventory: true,
            },
        });

        const review = entries.find((entry) => entry.actionId === 'review.start');
        expect(review).toBeTruthy();

        const chips = review!.targets.find((target) => target.id === 'agent_input_chips');
        const mcp = review!.targets.find((target) => target.id === 'mcp');

        expect(chips?.state).toBe('on');
        expect(mcp?.state).toBe('off');
    });

    it('presents the direct-cut API and trusted-plugin surfaces for configurable host actions', async () => {
        const { buildActionSettingsEntries } = await import('./buildActionSettingsEntries');

        const entries = buildActionSettingsEntries({
            query: '',
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            availability: {
                executionRunsEnabled: true,
                memorySearchEnabled: true,
                voiceEnabled: true,
                sessionHandoffEnabled: true,
                mcpServersEnabled: true,
                voiceShareDeviceInventory: true,
            },
        });

        const review = entries.find((entry) => entry.actionId === 'review.start');
        expect(review?.targets.find((target) => target.id === 'api')).toMatchObject({ state: 'on' });
        expect(review?.targets.find((target) => target.id === 'plugin')).toMatchObject({ state: 'on' });
    });

    it('builds contributed rows from one selected daemon projection with universal API availability', async () => {
        const { buildActionSettingsEntries } = await import('./buildActionSettingsEntries');

        const entries = buildActionSettingsEntries({
            query: '',
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            availability: {
                executionRunsEnabled: true,
                memorySearchEnabled: true,
                voiceEnabled: true,
                sessionHandoffEnabled: true,
                mcpServersEnabled: true,
                voiceShareDeviceInventory: true,
            },
            contributedActions: [{
                pluginId: 'com.acme.review',
                localId: 'review/start',
                title: 'Start Acme review',
                description: 'Starts a review from Acme.',
                icon: 'sparkle',
                surfaces: ['plugin'],
            }],
        });

        const contributed = entries.find((entry) => entry.actionId === 'com.acme.review/actions/review/start');
        expect(contributed).toMatchObject({
            title: 'Start Acme review',
            description: 'Starts a review from Acme.',
        });
        expect(contributed?.targets.find((target) => target.id === 'api')).toMatchObject({ state: 'on' });
        expect(contributed?.targets.find((target) => target.id === 'plugin')).toMatchObject({ state: 'on' });
    });

    it('retains removed qualified actions while preserving current long contributed labels', async () => {
        const { buildActionSettingsEntries } = await import('./buildActionSettingsEntries');
        const longTitle = 'Review action with a deliberately long, provider-authored presentation label that must not be truncated by the catalog owner';

        const entries = buildActionSettingsEntries({
            query: '',
            settings: ActionsSettingsV1Schema.parse({
                v: 1,
                actions: {
                    'com.acme.removed/actions/no-longer-installed': {
                        enabled: false,
                    },
                },
            }),
            availability: {
                executionRunsEnabled: true,
                memorySearchEnabled: true,
                voiceEnabled: true,
                sessionHandoffEnabled: true,
                mcpServersEnabled: true,
                voiceShareDeviceInventory: true,
            },
            contributedActions: [{
                pluginId: 'com.acme.review',
                localId: 'review/start',
                title: longTitle,
                description: null,
                icon: null,
                surfaces: [],
            }],
        });

        const current = entries.find((entry) => entry.actionId === 'com.acme.review/actions/review/start');
        expect(current).toMatchObject({
            kind: 'contributed',
            title: longTitle,
        });
        expect(current?.targets.find((target) => target.id === 'api')).toMatchObject({ state: 'on' });
        expect(current?.targets.find((target) => target.id === 'plugin')).toBeUndefined();
        expect(entries.find((entry) => entry.actionId === 'com.acme.removed/actions/no-longer-installed')).toMatchObject({
            kind: 'retained',
            enabled: false,
            targets: [],
        });
    });

    it('exposes contextual ui for ui-button actions and supports tokenized translated target search', async () => {
        const { buildActionSettingsEntries } = await import('./buildActionSettingsEntries');

        const approvalEntries = buildActionSettingsEntries({
            query: 'approval',
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            availability: {
                executionRunsEnabled: true,
                memorySearchEnabled: true,
                voiceEnabled: true,
                sessionHandoffEnabled: true,
                mcpServersEnabled: true,
                voiceShareDeviceInventory: true,
            },
        });

        const approval = approvalEntries.find((entry) => entry.actionId === 'approval.request.decide');
        expect(approval).toBeTruthy();
        expect(approval!.targets.some((target) => target.id === 'contextual_ui')).toBe(true);
        expect(approvalEntries.some((entry) => entry.actionId === 'review.start')).toBe(false);

        const sessionMenuEntries = buildActionSettingsEntries({
            query: 'palette global',
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            availability: {
                executionRunsEnabled: true,
                memorySearchEnabled: true,
                voiceEnabled: true,
                sessionHandoffEnabled: true,
                mcpServersEnabled: true,
                voiceShareDeviceInventory: true,
            },
            translate: (key) => {
                if (key === 'settingsActions.targets.command_palette.title') return 'Command palette';
                if (key === 'settingsActions.targets.command_palette.subtitle') return 'Visible in the global command palette.';
                return key;
            },
        });

        expect(sessionMenuEntries.length).toBeGreaterThan(0);
        expect(sessionMenuEntries.some((entry) => entry.targets.some((target) => target.id === 'command_palette'))).toBe(true);
    });

    it('exposes terminal composer clear through the pending-message placement', async () => {
        const { buildActionSettingsEntries } = await import('./buildActionSettingsEntries');

        const entries = buildActionSettingsEntries({
            query: '',
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            availability: {
                executionRunsEnabled: true,
                memorySearchEnabled: true,
                voiceEnabled: true,
                sessionHandoffEnabled: true,
                mcpServersEnabled: true,
                voiceShareDeviceInventory: true,
            },
        });

        const terminalComposerClear = entries.find((entry) => entry.actionId === 'session.terminalComposer.clear');
        expect(terminalComposerClear).toBeTruthy();
        expect(terminalComposerClear!.targets.some((target) => target.id === 'contextual_ui')).toBe(false);
        expect(terminalComposerClear!.targets.find((target) => target.id === 'pending_messages')).toMatchObject({
            id: 'pending_messages',
            state: 'on',
        });
    });

    it('surfaces the browser recording family once its real executor is enabled on ui/agent', async () => {
        // FINALIZATION-PLAN §3.2/§3.3 + BA-5: the whole browser recording family now routes through a
        // real executor (`RUNTIME_ACTION_REAL_EXECUTOR_*`) and is surfaced on `ui` + `agent`,
        // so each leaf becomes a configurable settings entry with a `agent` target. The
        // dangerous lifecycle leaves (`browser.recording.start`, classified `safety:'danger'`) keep an
        // approval-floored `agent` target per the consent floor.
        const { buildActionSettingsEntries } = await import('./buildActionSettingsEntries');

        const entries = buildActionSettingsEntries({
            query: 'browser recording',
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            availability: {
                executionRunsEnabled: true,
                memorySearchEnabled: true,
                voiceEnabled: true,
                sessionHandoffEnabled: true,
                mcpServersEnabled: true,
                voiceShareDeviceInventory: true,
            },
        });

        const attachRecording = entries.find((entry) => entry.actionId === 'browser.recording.attachToComposer');
        expect(attachRecording).toBeTruthy();
        expect(attachRecording!.targets.some((target) => target.id === 'agent')).toBe(true);

        // `browser.recording.start` is now executor-backed and surfaced on `ui`/`agent`. As a
        // danger lifecycle leaf it carries a `agent` target governed by the agent approval
        // floor (it is not silently hidden anymore).
        const startRecording = entries.find((entry) => entry.actionId === 'browser.recording.start');
        expect(startRecording).toBeTruthy();
        expect(startRecording!.targets.some((target) => target.id === 'agent')).toBe(true);
    });

    it('marks run placements unavailable when this client does not surface them yet', async () => {
        const { buildActionSettingsEntries } = await import('./buildActionSettingsEntries');

        const entries = buildActionSettingsEntries({
            query: '',
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            availability: {
                executionRunsEnabled: true,
                memorySearchEnabled: true,
                voiceEnabled: true,
                sessionHandoffEnabled: true,
                mcpServersEnabled: true,
                voiceShareDeviceInventory: true,
            },
        });

        const runListAction = entries.find((entry) => entry.actionId === 'execution.run.list');
        expect(runListAction).toBeTruthy();
        expect(runListAction!.targets.find((target) => target.id === 'run_list')).toMatchObject({
            id: 'run_list',
            state: 'unavailable',
            reasonKey: 'settingsActions.reasons.notAvailableInThisApp',
        });

        const runCardAction = entries.find((entry) => entry.actionId === 'execution.run.stop');
        expect(runCardAction).toBeTruthy();
        expect(runCardAction!.targets.find((target) => target.id === 'run_card')).toMatchObject({
            id: 'run_card',
            state: 'unavailable',
            reasonKey: 'settingsActions.reasons.notAvailableInThisApp',
        });
    });

    it('surfaces real-executor runtime families while hiding no-executor fail-closed contracts', async () => {
        // FINALIZATION-PLAN §3.2/§3.3: families with a real executor are surfaced on `ui`/
        // `agent` and become configurable; families with no executor stay fail-closed on
        // every surface and therefore have no settings target (hidden).
        const { buildActionSettingsEntries } = await import('./buildActionSettingsEntries');

        const entries = buildActionSettingsEntries({
            query: '',
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            availability: {
                executionRunsEnabled: true,
                memorySearchEnabled: true,
                voiceEnabled: true,
                sessionHandoffEnabled: true,
                mcpServersEnabled: true,
                voiceShareDeviceInventory: true,
            },
        });

        const isConfigurable = (actionId: string): boolean =>
            entries.some((entry) => entry.actionId === actionId);

        // Real executors → now configurable (with a agent target gated by the approval floor).
        expect(isConfigurable('browser.navigate')).toBe(true);
        expect(isConfigurable('localServices.publicPreview.create')).toBe(true);
        expect(isConfigurable('devices.simulator.input.tap')).toBe(true);
        for (const actionId of ['browser.navigate', 'localServices.publicPreview.create', 'devices.simulator.input.tap']) {
            const entry = entries.find((candidate) => candidate.actionId === actionId)!;
            expect(entry.targets.some((target) => target.id === 'agent')).toBe(true);
        }

        // browser.diagnostics.eval is now executor-backed (live sidecar CDP interaction transport,
        // DIAG-INTERACTION) → surfaced + configurable; its agent target stays approval-floored
        // (danger) per the consent floor. (browser.recording.start is likewise surfaced by its lane.)
        expect(isConfigurable('browser.diagnostics.eval')).toBe(true);
        expect(
            entries.find((candidate) => candidate.actionId === 'browser.diagnostics.eval')!.targets
                .some((target) => target.id === 'agent'),
        ).toBe(true);

        // No producer → still hidden (statically-unbacked / UNSURFACED on every surface).
        expect(isConfigurable('devices.simulator.input.orientation')).toBe(false);

        // No surfaced entry should ever have zero targets.
        expect(entries.some((entry) => entry.targets.length === 0)).toBe(false);
    });
});
