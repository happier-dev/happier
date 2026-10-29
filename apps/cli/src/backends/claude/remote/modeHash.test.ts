import { describe, expect, it } from 'vitest';
import type { EnhancedMode } from '@/backends/claude/loop';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';

import { hashClaudeEnhancedModeForQueue } from './modeHash';
import { pinClaudeRemoteModeToActiveRuntime } from './normalizeClaudeRemoteMode';

function makeMode(overrides?: Partial<EnhancedMode>): EnhancedMode {
    return {
        permissionMode: 'default',
        ...overrides,
    };
}

describe('hashClaudeEnhancedModeForQueue', () => {
    it.each([true, false])('keeps differing reclamation policies in separate input batches (SDK=%s)', async (claudeRemoteAgentSdkEnabled) => {
        const queue = new MessageQueue2<EnhancedMode>(hashClaudeEnhancedModeForQueue);
        const mode = makeMode({ claudeRemoteAgentSdkEnabled, claudeUnifiedTerminalEnabled: false, claudeRemoteIdleReclaimEnabled: true, claudeRemoteIdleReclaimTimeoutMinutes: 30 });
        queue.push('first', mode);
        queue.push('disable', { ...mode, claudeRemoteIdleReclaimEnabled: false });
        queue.push('timeout', { ...mode, claudeRemoteIdleReclaimTimeoutMinutes: 60 });
        expect((await queue.waitForMessagesAndGetAsString())?.message).toBe('first');
        expect((await queue.waitForMessagesAndGetAsString())?.mode.claudeRemoteIdleReclaimEnabled).toBe(false);
        expect((await queue.waitForMessagesAndGetAsString())?.mode.claudeRemoteIdleReclaimTimeoutMinutes).toBe(60);
    });
    it.each([{}, { claudeRemoteAgentSdkEnabled: false }, { claudeUnifiedTerminalEnabled: true }])('restarts for an entrypoint change in runtime %j', (runtime) => {
        const base = makeMode(runtime);
        const enabled = { ...base, claudeCodeIncludeInNativeHistory: true };
        const disabled = { ...base, claudeCodeIncludeInNativeHistory: false };
        expect(hashClaudeEnhancedModeForQueue(enabled)).not.toBe(hashClaudeEnhancedModeForQueue(base));
        expect(hashClaudeEnhancedModeForQueue(disabled)).toBe(hashClaudeEnhancedModeForQueue(base));
    });

    it('keeps runtime-selector changes out of the active runtime hash', () => {
        const agentSdkMode = makeMode({
            claudeRemoteAgentSdkEnabled: true,
            claudeUnifiedTerminalEnabled: false,
            claudeUnifiedTerminalHost: 'auto',
        });
        const unifiedMode = makeMode({
            claudeRemoteAgentSdkEnabled: true,
            claudeUnifiedTerminalEnabled: true,
            claudeUnifiedTerminalHost: 'auto',
        });

        expect(hashClaudeEnhancedModeForQueue(
            pinClaudeRemoteModeToActiveRuntime(unifiedMode, 'agentSdk'),
        )).toBe(hashClaudeEnhancedModeForQueue(agentSdkMode));
        expect(hashClaudeEnhancedModeForQueue(
            pinClaudeRemoteModeToActiveRuntime(agentSdkMode, 'unifiedTerminal'),
        )).toBe(hashClaudeEnhancedModeForQueue(unifiedMode));
    });

    it('treats missing Agent SDK flag like explicit Agent SDK enabled', () => {
        const missingFlag = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteSettingSourcesV2: ['project'],
        }));

        const explicitEnabled = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: true,
            claudeRemoteSettingSourcesV2: ['project'],
        }));

        const explicitLegacy = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: false,
            claudeRemoteSettingSourcesV2: ['project'],
        }));

        expect(missingFlag).toBe(explicitEnabled);
        expect(missingFlag).not.toBe(explicitLegacy);
    });

    it('changes when unified terminal is enabled', () => {
        const base = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: true,
            claudeUnifiedTerminalEnabled: false,
        } as any));

        const next = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: true,
            claudeUnifiedTerminalEnabled: true,
            claudeUnifiedTerminalHost: 'auto',
        } as any));

    expect(next).not.toBe(base);
  });

  it('changes when unified terminal resume choice changes', () => {
    const base = hashClaudeEnhancedModeForQueue(makeMode({
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'auto',
      claudeUnifiedTerminalResumeChoice: 'ask_every_time',
    } as any));

    const next = hashClaudeEnhancedModeForQueue(makeMode({
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'auto',
      claudeUnifiedTerminalResumeChoice: 'resume_full_session',
    } as any));

    expect(next).not.toBe(base);
  });

    it('changes when unified terminal host changes', () => {
        const base = hashClaudeEnhancedModeForQueue(makeMode({
            claudeUnifiedTerminalEnabled: true,
            claudeUnifiedTerminalHost: 'tmux',
        } as any));

        const next = hashClaudeEnhancedModeForQueue(makeMode({
            claudeUnifiedTerminalEnabled: true,
            claudeUnifiedTerminalHost: 'zellij',
        } as any));

        expect(next).not.toBe(base);
    });

    it('changes when resolved ultracode changes (agent SDK and unified terminal)', () => {
        for (const unified of [false, true]) {
            const base = hashClaudeEnhancedModeForQueue(makeMode({
                claudeRemoteAgentSdkEnabled: true,
                claudeUnifiedTerminalEnabled: unified,
                claudeUnifiedTerminalHost: unified ? 'auto' : undefined,
                model: 'claude-fable-5',
            } as any));

            const next = hashClaudeEnhancedModeForQueue(makeMode({
                claudeRemoteAgentSdkEnabled: true,
                claudeUnifiedTerminalEnabled: unified,
                claudeUnifiedTerminalHost: unified ? 'auto' : undefined,
                model: 'claude-fable-5',
                ultracode: true,
            } as any));

            expect(next).not.toBe(base);
        }
    });

    it('does not change for an ultracode request the model cannot honor', () => {
        const base = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: true,
            model: 'claude-sonnet-4-6',
        } as any));

        const next = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: true,
            model: 'claude-sonnet-4-6',
            ultracode: true,
        } as any));

        expect(next).toBe(base);
    });

    it('ignores Agent SDK fallback enablement when unified terminal is enabled', () => {
        const base = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: true,
            claudeUnifiedTerminalEnabled: true,
            claudeUnifiedTerminalHost: 'auto',
        } as any));

        const next = hashClaudeEnhancedModeForQueue(makeMode({
            claudeRemoteAgentSdkEnabled: false,
            claudeUnifiedTerminalEnabled: true,
            claudeUnifiedTerminalHost: 'auto',
        } as any));

        expect(next).toBe(base);
    });

    it('changes when max thinking tokens changes under unified terminal', () => {
        const base = hashClaudeEnhancedModeForQueue(makeMode({
            claudeUnifiedTerminalEnabled: true,
            claudeUnifiedTerminalHost: 'auto',
            claudeRemoteMaxThinkingTokens: null,
        } as any));

        const next = hashClaudeEnhancedModeForQueue(makeMode({
            claudeUnifiedTerminalEnabled: true,
            claudeUnifiedTerminalHost: 'auto',
            claudeRemoteMaxThinkingTokens: 4096,
        } as any));

        expect(next).not.toBe(base);
    });

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
