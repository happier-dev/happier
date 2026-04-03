import { describe, expect, it } from 'vitest';
import type { EnhancedMode } from '@/backends/claude/loop';

import { hashClaudeEnhancedModeForQueue } from './modeHash';

function makeMode(overrides?: Partial<EnhancedMode>): EnhancedMode {
    return {
        permissionMode: 'default',
        ...overrides,
    };
}

describe('hashClaudeEnhancedModeForQueue', () => {
    it('does not change when only model changes (Agent SDK enabled)', () => {
        const base = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: true,
            claudeRemoteSettingSourcesV2: ['project'],
            model: 'claude-sonnet',
        }));

        const next = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: true,
            claudeRemoteSettingSourcesV2: ['project'],
            model: 'claude-opus',
        }));

        expect(next).toBe(base);
    });

    it('changes when claudeRemoteDisableTodos changes (Agent SDK enabled)', () => {
        const base = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: true,
            claudeRemoteSettingSourcesV2: ['project'],
            claudeRemoteDisableTodos: false,
        }));

        const next = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: true,
            claudeRemoteSettingSourcesV2: ['project'],
            claudeRemoteDisableTodos: true,
        }));

        expect(next).not.toBe(base);
    });

    it('changes when claudeRemoteDebugEnabled changes (Agent SDK enabled)', () => {
        const base = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: true,
            claudeRemoteSettingSourcesV2: ['project'],
            claudeRemoteDebugEnabled: false,
        }));

        const next = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: true,
            claudeRemoteSettingSourcesV2: ['project'],
            claudeRemoteDebugEnabled: true,
        }));

        expect(next).not.toBe(base);
    });

    it('changes when claudeRemoteVerboseEnabled changes (Agent SDK enabled)', () => {
        const base = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: true,
            claudeRemoteSettingSourcesV2: ['project'],
            claudeRemoteVerboseEnabled: false,
        }));

        const next = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: true,
            claudeRemoteSettingSourcesV2: ['project'],
            claudeRemoteVerboseEnabled: true,
        }));

        expect(next).not.toBe(base);
    });

    it('changes when claudeRemoteDebugCategories changes (Agent SDK enabled)', () => {
        const base = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: true,
            claudeRemoteSettingSourcesV2: ['project'],
            claudeRemoteDebugEnabled: true,
            claudeRemoteDebugCategories: ['api'],
        }));

        const next = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: true,
            claudeRemoteSettingSourcesV2: ['project'],
            claudeRemoteDebugEnabled: true,
            claudeRemoteDebugCategories: ['mcp'],
        }));

        expect(next).not.toBe(base);
    });

    it('changes when settingSources changes (Agent SDK enabled)', () => {
        const base = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: true,
            claudeRemoteSettingSourcesV2: ['project'],
        }));

        const next = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: true,
            claudeRemoteSettingSourcesV2: [],
        }));

        expect(next).not.toBe(base);
    });

    it('changes when reasoning effort changes from default to low (Agent SDK enabled)', () => {
        const base = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: true,
            claudeRemoteSettingSourcesV2: ['project'],
            model: 'claude-opus-4-6',
        }));

        const next = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: true,
            claudeRemoteSettingSourcesV2: ['project'],
            model: 'claude-opus-4-6',
            reasoningEffort: 'low',
        }));

        expect(next).not.toBe(base);
    });

    it('does not change when reasoning effort is set to high (provider default; Agent SDK enabled)', () => {
        const base = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: true,
            claudeRemoteSettingSourcesV2: ['project'],
            model: 'claude-opus-4-6',
        }));

        const next = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: true,
            claudeRemoteSettingSourcesV2: ['project'],
            model: 'claude-opus-4-6',
            reasoningEffort: 'high',
        }));

        expect(next).toBe(base);
    });

    it('changes when claudeRemoteDisableTodos changes (Agent SDK disabled)', () => {
        const base = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: false,
            claudeRemoteDisableTodos: false,
        }));

        const next = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: false,
            claudeRemoteDisableTodos: true,
        }));

        expect(next).not.toBe(base);
    });

    it('changes when claudeRemoteDebugEnabled changes (Agent SDK disabled)', () => {
        const base = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: false,
            claudeRemoteDebugEnabled: false,
        }));

        const next = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: false,
            claudeRemoteDebugEnabled: true,
        }));

        expect(next).not.toBe(base);
    });

    it('changes when reasoningEffort changes (Agent SDK disabled)', () => {
        const base = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: false,
            model: 'claude-opus-4-6',
            reasoningEffort: 'low',
        }));

        const next = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: false,
            model: 'claude-opus-4-6',
            reasoningEffort: 'max',
        }));

        expect(next).not.toBe(base);
    });

    it('changes when fallbackModel changes (Agent SDK enabled)', () => {
        const base = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: true,
            claudeRemoteSettingSourcesV2: ['project'],
            fallbackModel: 'claude-haiku',
        }));

        const next = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: true,
            claudeRemoteSettingSourcesV2: ['project'],
            fallbackModel: 'claude-opus',
        }));

        expect(next).not.toBe(base);
    });

    it('changes when agent mode toggles between plan and non-plan (Agent SDK disabled)', () => {
        const base = hashClaudeEnhancedModeForQueue(makeMode({
            permissionMode: 'default',
            claudeRemoteAgentSdkEnabled: false,
        }));

        const next = hashClaudeEnhancedModeForQueue(makeMode({
            permissionMode: 'read-only',
            agentModeId: 'plan',
            claudeRemoteAgentSdkEnabled: false,
        }));

        expect(next).not.toBe(base);
    });

    it('changes when replaySeedAllowed changes', () => {
        const base = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: true,
            claudeRemoteSettingSourcesV2: ['project'],
            replaySeedAllowed: true,
        }));

        const next = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: true,
            claudeRemoteSettingSourcesV2: ['project'],
            replaySeedAllowed: false,
        }));

        expect(next).not.toBe(base);
    });
});
