import { describe, expect, it } from 'vitest';

import {
  ANTIGRAVITY_PRINT_MODE_SUPPORTED,
  buildAntigravityTerminalLaunchArgs,
  resolveAntigravityTerminalLaunchArgsInput,
} from './launchArgs.js';

describe('Antigravity terminal launch arguments', () => {
  it('builds only documented interactive TUI flags', () => {
    expect(buildAntigravityTerminalLaunchArgs({
      promptInteractive: true,
      conversationId: 'conv-123',
      continueLatest: true,
      sandbox: true,
      logFile: '/tmp/agy.log',
      modelId: 'Gemini 3.5 Flash (High)',
    })).toEqual([
      '--prompt-interactive',
      '--conversation',
      'conv-123',
      '--continue',
      '--sandbox',
      '--log-file',
      '/tmp/agy.log',
      '--model',
      'Gemini 3.5 Flash (High)',
    ]);
  });

  it('omits the model flag when the selected model is blank or the default sentinel', () => {
    expect(buildAntigravityTerminalLaunchArgs({
      modelId: '   ',
    })).toEqual([]);
    expect(buildAntigravityTerminalLaunchArgs({
      modelId: 'default',
    })).toEqual([]);
  });

  it('uses the canonical provider session identity for terminal continuation', () => {
    expect(resolveAntigravityTerminalLaunchArgsInput({
      providerSessionId: 'conversation-current',
      terminalRuntime: { conversationId: 'conversation-stale' },
      antigravity: { conversationId: 'conversation-older' },
    }, null)).toMatchObject({
      conversationId: 'conversation-current',
    });
  });

  it('uses the host-resolved active model when newer intent and raw metadata disagree', () => {
    expect(resolveAntigravityTerminalLaunchArgsInput({
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 41,
        selection: {
          agentTargetKey: 'backend:antigravity',
          providerConnectionId: 'pc_next',
          modelId: 'proposed-provider-model',
        },
      },
      terminalRuntime: { modelId: 'unproven-terminal-model' },
      antigravity: { model: 'unproven-agent-model' },
      modelId: 'unproven-top-level-model',
    }, {
      agentTargetKey: 'backend:antigravity',
      providerConnectionId: null,
      modelId: 'active-native-model',
    })).toMatchObject({
      modelId: 'active-native-model',
    });
  });

  it('launches the host-resolved Provider-bound selection for a replacement runtime', () => {
    expect(resolveAntigravityTerminalLaunchArgsInput({
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 41,
        selection: {
          agentTargetKey: 'backend:antigravity',
          providerConnectionId: 'pc_next',
          modelId: 'next-launch-provider-model',
        },
      },
    }, {
      agentTargetKey: 'backend:antigravity',
      providerConnectionId: 'pc_next',
      modelId: 'next-launch-provider-model',
    })).toMatchObject({
      modelId: 'next-launch-provider-model',
    });
  });

  it('does not promote catalog fallback, Provider intent, or raw metadata without host selection', () => {
    expect(resolveAntigravityTerminalLaunchArgsInput({
      sessionModelsV1: {
        v: 1,
        agentId: 'antigravity',
        updatedAt: 40,
        currentModelId: 'fallback-native-model',
        availableModels: [
          { id: 'fallback-native-model', name: 'Fallback native model' },
        ],
      },
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 41,
        selection: {
          agentTargetKey: 'backend:antigravity',
          providerConnectionId: 'pc_next',
          modelId: 'next-launch-provider-model',
        },
      },
      terminalRuntime: { modelId: 'unproven-terminal-model' },
      antigravity: { model: 'unproven-agent-model' },
      modelId: 'unproven-top-level-model',
    }, null)).toMatchObject({
      modelId: null,
    });
  });

  it('keeps print mode and unsafe permission skipping out of terminal v1', () => {
    expect(ANTIGRAVITY_PRINT_MODE_SUPPORTED).toBe(false);
    expect(() => buildAntigravityTerminalLaunchArgs({
      unsafeSkipPermissions: true,
    })).toThrow(/unsafe permission/i);
    expect(() => buildAntigravityTerminalLaunchArgs({
      print: true,
    })).toThrow(/print mode/i);
  });
});
