import { describe, expect, it } from 'vitest';

import { settingsDefaults } from '@/sync/domains/settings/settings';

import { buildAccountSettingsSnapshot } from './buildAccountSettingsSnapshot';

describe('buildAccountSettingsSnapshot', () => {
    it('tracks transcript and tool presentation settings from the canonical account registry', () => {
        const snapshot = buildAccountSettingsSnapshot({
            ...settingsDefaults,
            toolViewDetailLevelDefault: 'compact',
            toolViewDetailLevelDefaultLocalControl: 'full',
            toolViewShowDebugByDefault: true,
            toolViewTapAction: 'open',
            toolViewExpandedDetailLevelDefault: 'full',
            transcriptGroupingMode: 'linear',
            transcriptGroupToolCalls: false,
            transcriptTurnToolCallsGroupStrategy: 'all_tools_in_turn',
            transcriptToolCallsGroupShowBackground: false,
            transcriptStreamingCoalesceEnabled: false,
            transcriptListImplementation: 'flatlist_legacy',
            toolViewTimelineChromeMode: 'cards',
            toolViewTimelineFeedDefaultExpanded: true,
            transcriptMotionPreset: 'full',
            transcriptAnimateNewItemsEnabled: false,
            transcriptAnimateToolExpandCollapseEnabled: false,
            transcriptAnimateToolExpandCollapseFreshOnly: false,
            transcriptAnimateThinkingEnabled: false,
            transcriptScrollPinEnabled: false,
            transcriptScrollAutoFollowWhenPinned: false,
            transcriptScrollJumpToBottomEnabled: false,
            transcriptScrollJumpToBottomAnimateScroll: false,
            permissionPromptSurface: 'both',
        });

        expect(snapshot.properties.acct_setting__toolViewDetailLevelDefault).toBe('compact');
        expect(snapshot.properties.acct_setting__toolViewDetailLevelDefaultLocalControl).toBe('full');
        expect(snapshot.properties.acct_setting__toolViewShowDebugByDefault).toBe(true);
        expect(snapshot.properties.acct_setting__toolViewTapAction).toBe('open');
        expect(snapshot.properties.acct_setting__toolViewExpandedDetailLevelDefault).toBe('full');
        expect(snapshot.properties.acct_setting__transcriptGroupingMode).toBe('linear');
        expect(snapshot.properties.acct_setting__transcriptGroupToolCalls).toBe(false);
        expect(snapshot.properties.acct_setting__transcriptTurnToolCallsGroupStrategy).toBe('all_tools_in_turn');
        expect(snapshot.properties.acct_setting__transcriptToolCallsGroupShowBackground).toBe(false);
        expect(snapshot.properties.acct_setting__transcriptStreamingCoalesceEnabled).toBe(false);
        expect(snapshot.properties.acct_setting__transcriptListImplementation).toBe('flatlist_legacy');
        expect(snapshot.properties.acct_setting__toolViewTimelineChromeMode).toBe('cards');
        expect(snapshot.properties.acct_setting__toolViewTimelineFeedDefaultExpanded).toBe(true);
        expect(snapshot.properties.acct_setting__transcriptMotionPreset).toBe('full');
        expect(snapshot.properties.acct_setting__transcriptAnimateNewItemsEnabled).toBe(false);
        expect(snapshot.properties.acct_setting__transcriptAnimateToolExpandCollapseEnabled).toBe(false);
        expect(snapshot.properties.acct_setting__transcriptAnimateToolExpandCollapseFreshOnly).toBe(false);
        expect(snapshot.properties.acct_setting__transcriptAnimateThinkingEnabled).toBe(false);
        expect(snapshot.properties.acct_setting__transcriptScrollPinEnabled).toBe(false);
        expect(snapshot.properties.acct_setting__transcriptScrollAutoFollowWhenPinned).toBe(false);
        expect(snapshot.properties.acct_setting__transcriptScrollJumpToBottomEnabled).toBe(false);
        expect(snapshot.properties.acct_setting__transcriptScrollJumpToBottomAnimateScroll).toBe(false);
        expect(snapshot.properties.acct_setting__permissionPromptSurface).toBe('both');
    });

    it('tracks runtime and tool override summaries from canonical analytics serializers', () => {
        const snapshot = buildAccountSettingsSnapshot({
            ...settingsDefaults,
            sessionReplaySummaryRunnerV1: {
                v: 1,
                backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                modelId: 'claude-sonnet-4-5',
            },
            sessionTmuxIsolated: false,
            toolViewDetailLevelByToolName: {
                ReadFile: 'summary',
                EditFile: 'full',
            },
            toolViewExpandedDetailLevelByToolName: {
                ReadFile: 'full',
            },
        } as typeof settingsDefaults);

        expect(snapshot.properties.acct_setting__sessionReplaySummaryRunnerV1).toBe(true);
        expect(snapshot.properties.acct_setting__sessionTmuxIsolated).toBe(false);
        expect(snapshot.properties.acct_setting__toolViewDetailLevelByToolName__overrideCount).toBe(2);
        expect(snapshot.properties.acct_setting__toolViewExpandedDetailLevelByToolName__overrideCount).toBe(1);
        expect(snapshot.properties.acct_setting__attachmentsUploadsWorkspaceRelativeDir).toBeUndefined();
        expect(snapshot.properties.acct_setting__serverSelectionActiveTargetId).toBeUndefined();
    });
});

