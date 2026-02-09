import { describe, expect, it } from 'vitest';

import { settingsParse } from '@/sync/domains/settings/settings';

describe('settingsParse provider plugin defaults', () => {
    it('includes Claude provider defaults when no settings are persisted', () => {
        const settings = settingsParse({});

        expect((settings as any).claudeRemoteAgentSdkEnabled).toBe(false);
        expect((settings as any).claudeRemoteSettingSources).toBe('project');
        expect((settings as any).claudeRemoteIncludePartialMessages).toBe(false);
        expect((settings as any).claudeRemoteEnableFileCheckpointing).toBe(false);
        expect((settings as any).claudeRemoteMaxThinkingTokens).toBe(null);
        expect((settings as any).claudeRemoteDisableTodos).toBe(false);
        expect((settings as any).claudeRemoteStrictMcpServerConfig).toBe(false);
        expect((settings as any).claudeRemoteAdvancedOptionsJson).toBe('');
        expect((settings as any).codexBackendMode).toBe('mcp');
        expect((settings as any).codexMcpResumeInstallSpec).toBe('');
        expect((settings as any).codexAcpInstallSpec).toBe('');
    });

    it('rejects invalid JSON payloads for JSON provider setting fields', () => {
        const settings = settingsParse({
            claudeRemoteAdvancedOptionsJson: '{ not-valid-json }',
        } as any);

        expect((settings as any).claudeRemoteAdvancedOptionsJson).toBe('');
    });
});
