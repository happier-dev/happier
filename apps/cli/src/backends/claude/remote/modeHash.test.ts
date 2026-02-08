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
            claudeRemoteSettingSources: 'project',
            model: 'claude-sonnet',
        }));

        const next = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: true,
            claudeRemoteSettingSources: 'project',
            model: 'claude-opus',
        }));

        expect(next).toBe(base);
    });

    it('changes when claudeRemoteDisableTodos changes (Agent SDK enabled)', () => {
        const base = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: true,
            claudeRemoteSettingSources: 'project',
            claudeRemoteDisableTodos: false,
        }));

        const next = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: true,
            claudeRemoteSettingSources: 'project',
            claudeRemoteDisableTodos: true,
        }));

        expect(next).not.toBe(base);
    });

    it('changes when settingSources changes (Agent SDK enabled)', () => {
        const base = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: true,
            claudeRemoteSettingSources: 'project',
        }));

        const next = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: true,
            claudeRemoteSettingSources: 'none',
        }));

        expect(next).not.toBe(base);
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

    it('changes when fallbackModel changes (Agent SDK enabled)', () => {
        const base = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: true,
            claudeRemoteSettingSources: 'project',
            fallbackModel: 'claude-haiku',
        }));

        const next = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: true,
            claudeRemoteSettingSources: 'project',
            fallbackModel: 'claude-opus',
        }));

        expect(next).not.toBe(base);
    });

    it('changes when permission mode toggles between plan and non-plan (Agent SDK disabled)', () => {
        const base = hashClaudeEnhancedModeForQueue(makeMode({
            permissionMode: 'default',
            claudeRemoteAgentSdkEnabled: false,
        }));

        const next = hashClaudeEnhancedModeForQueue(makeMode({
            permissionMode: 'plan',
            claudeRemoteAgentSdkEnabled: false,
        }));

        expect(next).not.toBe(base);
    });
});
