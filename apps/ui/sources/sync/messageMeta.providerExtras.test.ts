import { describe, expect, it } from 'vitest';

import { buildOutgoingMessageMeta } from '@/sync/messageMeta';
import { settingsParse } from '@/sync/settings';
import { addProviderMessageMetaExtras } from '@/sync/messageMetaProviders';

describe('addProviderMessageMetaExtras', () => {
    it('returns the original meta for providers without settings plugins', () => {
        const base = buildOutgoingMessageMeta({
            sentFrom: 'e2e',
            permissionMode: 'default',
            appendSystemPrompt: 'SYSTEM',
        });

        const merged = addProviderMessageMetaExtras({
            meta: base,
            agentId: 'qwen',
            settings: {},
            session: { id: 's1' },
        });

        expect(merged).toEqual(base);
    });

    it('merges provider plugin meta extras for Claude sessions', () => {
        const settings = settingsParse({
            claudeRemoteAgentSdkEnabled: true,
            claudeRemoteSettingSources: 'project',
            claudeRemoteIncludePartialMessages: true,
        });

        const base = buildOutgoingMessageMeta({
            sentFrom: 'e2e',
            permissionMode: 'default',
            appendSystemPrompt: 'SYSTEM',
        });

        const merged = addProviderMessageMetaExtras({
            meta: base,
            agentId: 'claude',
            settings,
            session: { id: 's1' },
        });

        expect((merged as any).claudeRemoteAgentSdkEnabled).toBe(true);
        expect((merged as any).claudeRemoteSettingSources).toBe('project');
        expect((merged as any).claudeRemoteIncludePartialMessages).toBe(true);
    });

    it('drops oversized provider advanced options JSON payloads before meta merge', () => {
        const hugeJson = JSON.stringify({
            tools: { note: 'x'.repeat(32_000) },
        });
        const settings = settingsParse({
            claudeRemoteAdvancedOptionsJson: hugeJson,
        });

        const base = buildOutgoingMessageMeta({
            sentFrom: 'e2e',
            permissionMode: 'default',
            appendSystemPrompt: 'SYSTEM',
        });

        const merged = addProviderMessageMetaExtras({
            meta: base,
            agentId: 'claude',
            settings,
            session: { id: 's1' },
        });

        expect((merged as any).claudeRemoteAdvancedOptionsJson).toBe('');
    });
});
