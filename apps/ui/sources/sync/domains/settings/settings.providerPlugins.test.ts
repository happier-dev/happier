import { describe, expect, it } from 'vitest';

import { settingsParse } from '@/sync/domains/settings/settings';

describe('settingsParse provider plugin defaults', () => {
    it('includes Claude provider defaults when no settings are persisted', () => {
        const settings = settingsParse({});

        expect((settings as any).claudeRemoteAgentSdkEnabled).toBe(true);
        expect((settings as any).claudeRemoteSettingSources).toBe('user_project');
        expect((settings as any).claudeRemoteSettingSourcesV2).toEqual(['user', 'project', 'local']);
        expect((settings as any).claudeRemoteIncludePartialMessages).toBe(false);
        expect((settings as any).claudeLocalPermissionBridgeEnabled).toBe(true);
        expect((settings as any).claudeLocalPermissionBridgeWaitIndefinitely).toBe(true);
        expect((settings as any).claudeLocalPermissionBridgeTimeoutSeconds).toBe(600);
        expect((settings as any).claudeRemoteEnableFileCheckpointing).toBe(false);
        expect((settings as any).claudeRemoteMaxThinkingTokens).toBe(null);
        expect((settings as any).claudeRemoteDisableTodos).toBe(false);
        expect((settings as any).claudeRemoteStrictMcpServerConfig).toBe(false);
        expect((settings as any).claudeRemoteAdvancedOptionsJson).toBe('');
        expect((settings as any).claudeCodeExperimentalAgentTeamsEnabled).toBe(false);
        expect((settings as any).codexBackendMode).toBe('appServer');
        expect((settings as any).backendCliSourcePreferenceById).toEqual({});
    });

    it('preserves legacy Codex backend mode when migrating settings from schema v5', () => {
        const settings = settingsParse({
            schemaVersion: 5,
            codexBackendMode: 'mcp',
        } as any);

        expect((settings as any).schemaVersion).toBe(6);
        expect((settings as any).codexBackendMode).toBe('mcp');
    });

    it('respects persisted Claude provider settings (can disable Agent SDK)', () => {
        const settings = settingsParse({
            claudeRemoteAgentSdkEnabled: false,
        } as any);

        expect((settings as any).claudeRemoteAgentSdkEnabled).toBe(false);
    });

    it('rejects invalid JSON payloads for JSON provider setting fields', () => {
        const settings = settingsParse({
            claudeRemoteAdvancedOptionsJson: '{ not-valid-json }',
        } as any);

        expect((settings as any).claudeRemoteAdvancedOptionsJson).toBe('');
    });

    it('preserves valid backend CLI source preferences and drops invalid values', () => {
        const settings = settingsParse({
            backendCliSourcePreferenceById: {
                codex: 'managed-first',
                gemini: 'system-first',
                invalid: 'nope',
            },
        } as any);

        expect((settings as any).backendCliSourcePreferenceById).toEqual({
            codex: 'managed-first',
            gemini: 'system-first',
        });
    });
});
