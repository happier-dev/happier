import { describe, expect, it } from 'vitest';

import {
    buildClaudeRemoteOutgoingMessageMetaExtras,
} from './messageMeta.js';

describe('buildClaudeRemoteOutgoingMessageMetaExtras', () => {
    it('uses Claude plugin defaults when persisted settings omit fields', () => {
        const extras = buildClaudeRemoteOutgoingMessageMetaExtras({});

        expect(extras).toMatchObject({
            claudeRemoteAgentSdkEnabled: true,
            claudeUnifiedTerminalEnabled: false,
            claudeUnifiedTerminalHost: 'auto',
            claudeCodeExperimentalAgentTeamsEnabled: false,
            claudeLocalPermissionBridgeEnabled: true,
            claudeLocalPermissionBridgeWaitIndefinitely: true,
            claudeLocalPermissionBridgeTimeoutSeconds: 600,
            claudeRemoteEnableFileCheckpointing: false,
            claudeRemoteMaxThinkingTokens: null,
            claudeRemoteDisableTodos: false,
            claudeRemoteStrictMcpServerConfig: false,
            claudeRemoteDebugEnabled: false,
            claudeRemoteVerboseEnabled: false,
            claudeRemoteDebugCategories: [],
            claudeRemoteAdvancedOptionsJson: '',
            claudeRemoteSettingSourcesV2: ['user', 'project', 'local'],
        });
        expect(extras.claudeRemoteSettingSources).toBeUndefined();
    });

    it('preserves explicit persisted values, including false booleans', () => {
        const extras = buildClaudeRemoteOutgoingMessageMetaExtras({
            claudeRemoteAgentSdkEnabled: false,
            claudeUnifiedTerminalEnabled: true,
            claudeUnifiedTerminalHost: 'zellij',
            claudeLocalPermissionBridgeEnabled: false,
            claudeLocalPermissionBridgeWaitIndefinitely: false,
            claudeLocalPermissionBridgeTimeoutSeconds: 42,
            claudeRemoteMaxThinkingTokens: 4096,
            claudeRemoteDebugEnabled: true,
            claudeRemoteVerboseEnabled: true,
            claudeRemoteDebugCategories: ['mcp', 'api', 'api', 'bogus', 'file'],
            claudeRemoteAdvancedOptionsJson: '{ "beta": true }',
        });

        expect(extras).toMatchObject({
            claudeRemoteAgentSdkEnabled: false,
            claudeUnifiedTerminalEnabled: true,
            claudeUnifiedTerminalHost: 'zellij',
            claudeLocalPermissionBridgeEnabled: false,
            claudeLocalPermissionBridgeWaitIndefinitely: false,
            claudeLocalPermissionBridgeTimeoutSeconds: 42,
            claudeRemoteMaxThinkingTokens: 4096,
            claudeRemoteDebugEnabled: true,
            claudeRemoteVerboseEnabled: true,
            claudeRemoteDebugCategories: ['api', 'mcp', 'file'],
            claudeRemoteAdvancedOptionsJson: '{"beta":true}',
        });
    });

    it('falls back to unified terminal defaults for malformed persisted values', () => {
        const extras = buildClaudeRemoteOutgoingMessageMetaExtras({
            claudeUnifiedTerminalEnabled: 'true',
            claudeUnifiedTerminalHost: 'screen',
        });

        expect(extras.claudeUnifiedTerminalEnabled).toBe(false);
        expect(extras.claudeUnifiedTerminalHost).toBe('auto');
    });

    it('maps legacy Claude setting-source values into the canonical V2 field', () => {
        expect(buildClaudeRemoteOutgoingMessageMetaExtras({
            claudeRemoteSettingSources: 'none',
        })).toMatchObject({
            claudeRemoteSettingSourcesV2: [],
            claudeRemoteSettingSources: 'none',
        });
        expect(buildClaudeRemoteOutgoingMessageMetaExtras({
            claudeRemoteSettingSources: 'user_project',
        })).toMatchObject({
            claudeRemoteSettingSourcesV2: ['user', 'project'],
            claudeRemoteSettingSources: 'user_project',
        });
    });
});
