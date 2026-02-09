import { describe, expect, it } from 'vitest';

import type { AgentId } from '@/agents/catalog/catalog';
import { settingsParse } from '@/sync/domains/settings/settings';
import { buildSendMessageMeta } from '@/sync/domains/messages/buildSendMessageMeta';

function buildArgs(overrides?: {
    agentId?: AgentId | null;
    sentFrom?: string;
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    appendSystemPrompt?: string;
    displayText?: string;
    model?: string | null;
    fallbackModel?: string | null;
    settings?: Record<string, unknown>;
}) {
    return {
        sentFrom: overrides?.sentFrom ?? 'e2e',
        permissionMode: overrides?.permissionMode ?? 'default',
        appendSystemPrompt: overrides?.appendSystemPrompt ?? 'SYSTEM',
        displayText: overrides?.displayText,
        model: overrides?.model,
        fallbackModel: overrides?.fallbackModel,
        agentId: overrides?.agentId ?? 'claude',
        settings: overrides?.settings ?? settingsParse({}),
        session: { id: 's1' },
    };
}

describe('buildSendMessageMeta', () => {
    it('includes provider plugin meta extras for Claude sessions', () => {
        const settings = settingsParse({ claudeRemoteAgentSdkEnabled: true, claudeRemoteSettingSources: 'project' });
        const meta = buildSendMessageMeta(buildArgs({ settings, displayText: 'hello', agentId: 'claude' }));
        const extras = meta as Record<string, unknown>;

        expect(extras.claudeRemoteAgentSdkEnabled).toBe(true);
        expect(extras.claudeRemoteSettingSources).toBe('project');
        expect(meta.sentFrom).toBe('e2e');
        expect(meta.source).toBe('ui');
    });

    it('does not add provider extras for non-Claude agents', () => {
        const meta = buildSendMessageMeta(buildArgs({ agentId: 'codex' }));
        const extras = meta as Record<string, unknown>;

        expect(extras.claudeRemoteAgentSdkEnabled).toBeUndefined();
        expect(extras.claudeRemoteSettingSources).toBeUndefined();
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
});
