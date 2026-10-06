import { describe, expect, it } from 'vitest';

import { settingsParse } from '@/sync/domains/settings/settings';
import { buildSendMessageMeta } from '@/sync/domains/messages/buildSendMessageMeta';

type SendMessageArgs = Parameters<typeof buildSendMessageMeta>[0];

function buildArgs(overrides?: Partial<SendMessageArgs>): SendMessageArgs {
    return {
        sentFrom: overrides?.sentFrom ?? 'e2e',
        permissionMode: overrides?.permissionMode ?? 'default',
        appendSystemPrompt: overrides?.appendSystemPrompt ?? 'SYSTEM',
        displayText: overrides?.displayText,
        model: overrides?.model,
        fallbackModel: overrides?.fallbackModel,
        agentId: overrides?.agentId === undefined ? 'claude' : overrides.agentId,
        settings: overrides?.settings ?? settingsParse({}),
        session: overrides?.session ?? { id: 's1' },
        metaOverrides: overrides?.metaOverrides,
    };
}

describe('buildSendMessageMeta', () => {
    it('includes provider plugin meta extras for Claude sessions', () => {
        const settings = settingsParse({
            claudeRemoteAgentSdkEnabled: true,
            claudeRemoteSettingSourcesV2: ['project'],
            claudeLocalPermissionBridgeEnabled: true,
            claudeLocalPermissionBridgeWaitIndefinitely: false,
            claudeLocalPermissionBridgeTimeoutSeconds: 123,
            claudeCodeExperimentalAgentTeamsEnabled: true,
            claudeRemoteAdvancedOptionsJson: '{"settingSources":["project"]}',
        });
        const meta = buildSendMessageMeta(buildArgs({ settings, displayText: 'hello', agentId: 'claude' }));
        const extras = meta;

        expect(extras.claudeRemoteAgentSdkEnabled).toBe(true);
        expect(extras.claudeRemoteSettingSourcesV2).toEqual(['project']);
        expect(extras.claudeRemoteSettingSources).toBe('project');
        expect(extras.claudeLocalPermissionBridgeEnabled).toBe(true);
        expect(extras.claudeLocalPermissionBridgeWaitIndefinitely).toBe(false);
        expect(extras.claudeLocalPermissionBridgeTimeoutSeconds).toBe(123);
        // `remote-dev` 9b097966a35e643b51e84af987a1f30869696416 reads
        // these legacy metadata fields to reconstruct Claude runtime options.
        expect(extras.claudeCodeExperimentalAgentTeamsEnabled).toBe(true);
        expect(extras.claudeRemoteAdvancedOptionsJson).toBe('{"settingSources":["project"]}');
        expect(meta.sentFrom).toBe('e2e');
        expect(meta.source).toBe('ui');
    });

    it('does not add provider extras for non-Claude agents', () => {
        const meta = buildSendMessageMeta(buildArgs({ agentId: 'codex' }));
        const extras = meta;

        expect(extras.claudeRemoteAgentSdkEnabled).toBeUndefined();
        expect(extras.claudeRemoteSettingSources).toBeUndefined();
        expect(extras.claudeRemoteSettingSourcesV2).toBeUndefined();
    });

    it('keeps only base metadata when agentId is null', () => {
        const meta = buildSendMessageMeta(buildArgs({ agentId: null, displayText: undefined }));

        expect(meta).toMatchObject({
            sentFrom: 'e2e',
            source: 'ui',
            permissionMode: 'default',
            appendSystemPrompt: 'SYSTEM',
        });
        expect(Object.prototype.hasOwnProperty.call(meta, 'displayText')).toBe(false);
    });

    it('omits appendSystemPrompt when the caller does not provide one', () => {
        const args = buildArgs({ agentId: null });
        delete args.appendSystemPrompt;

        const meta = buildSendMessageMeta(args);

        expect(Object.prototype.hasOwnProperty.call(meta, 'appendSystemPrompt')).toBe(false);
    });

    it('includes optional model and fallbackModel when provided', () => {
        const meta = buildSendMessageMeta(
            buildArgs({
                agentId: null,
                model: 'claude-sonnet-4',
                fallbackModel: 'claude-3-5-sonnet',
                displayText: 'visible-text',
            }),
        );

        expect(meta.model).toBe('claude-sonnet-4');
        expect(meta.fallbackModel).toBe('claude-3-5-sonnet');
        expect(meta.displayText).toBe('visible-text');
    });

    it('shallow merges metaOverrides (including meta.happier) while preserving provider extras', () => {
        const settings = settingsParse({
            claudeRemoteAgentSdkEnabled: true,
            claudeRemoteSettingSourcesV2: ['project'],
            claudeLocalPermissionBridgeEnabled: true,
            claudeLocalPermissionBridgeWaitIndefinitely: false,
            claudeLocalPermissionBridgeTimeoutSeconds: 123,
        });
        const meta = buildSendMessageMeta(buildArgs({
            settings,
            agentId: 'claude',
            metaOverrides: {
                happier: {
                    kind: 'review_comments.v1',
                    payload: { sessionId: 's1', comments: [] },
                },
            },
        }));

        expect(meta).toMatchObject({
            happier: { kind: 'review_comments.v1' },
            claudeRemoteAgentSdkEnabled: true,
        });
    });

    it('keeps an explicit reasoningEffort meta override instead of replacing it from Claude session metadata', () => {
        const meta = buildSendMessageMeta(buildArgs({
            agentId: 'claude',
            session: {
                id: 's1',
                metadata: {
                    sessionConfigOptionOverridesV1: {
                        v: 1,
                        updatedAt: 12,
                        overrides: {
                            reasoning_effort: {
                                updatedAt: 12,
                                value: 'low',
                            },
                        },
                    },
                },
            },
            metaOverrides: {
                reasoningEffort: 'medium',
            },
        }));

        expect(meta.reasoningEffort).toBe('medium');
    });

    it('does not overwrite an explicit Claude predecessor metadata override', () => {
        const meta = buildSendMessageMeta(buildArgs({
            agentId: 'claude',
            settings: settingsParse({ claudeCodeExperimentalAgentTeamsEnabled: true }),
            metaOverrides: { claudeCodeExperimentalAgentTeamsEnabled: false },
        }));

        expect(meta.claudeCodeExperimentalAgentTeamsEnabled).toBe(false);
    });
});
