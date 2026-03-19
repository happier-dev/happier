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
        const voiceTool = paths!.targets.find((target) => target.id === 'voice_tool');

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
});
