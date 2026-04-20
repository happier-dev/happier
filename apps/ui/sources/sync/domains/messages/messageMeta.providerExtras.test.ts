import { describe, expect, it } from 'vitest';

import { buildOutgoingMessageMeta } from '@/sync/domains/messages/messageMeta';
import { settingsParse } from '@/sync/domains/settings/settings';
import {
    addProviderMessageMetaExtras,
    resolveProviderMessageMetaOverrides,
} from '@/sync/domains/messages/messageMetaProviders';

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
            claudeRemoteSettingSourcesV2: ['project'],
            claudeLocalPermissionBridgeEnabled: true,
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
        expect((merged as any).claudeRemoteSettingSourcesV2).toEqual(['project']);
        expect((merged as any).claudeLocalPermissionBridgeEnabled).toBe(true);
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

describe('resolveProviderMessageMetaOverrides', () => {
    it('applies provider-owned message-meta overrides for Claude', () => {
        const overrides = resolveProviderMessageMetaOverrides({
            agentId: 'claude',
            session: {
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
                happier: {
                    kind: 'review_comments.v1',
                    payload: { sessionId: 's1', comments: [] },
                },
            },
        });

        expect((overrides as any)?.reasoningEffort).toBe('low');
        expect((overrides as any)?.happier?.kind).toBe('review_comments.v1');
    });

    it('passes through overrides for providers without message-meta override builders', () => {
        const passthrough = {
            happier: {
                kind: 'review_comments.v1',
                payload: { sessionId: 's1', comments: [] },
            },
        } as const;

        expect(resolveProviderMessageMetaOverrides({
            agentId: 'codex',
            session: { id: 's1' },
            metaOverrides: passthrough,
        })).toEqual(passthrough);
    });
});
