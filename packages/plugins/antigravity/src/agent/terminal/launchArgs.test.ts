import { describe, expect, it } from 'vitest';

import {
  buildAntigravityTerminalLaunchArgs,
  resolveAntigravityTerminalLaunchArgsInput,
} from './launchArgs.js';
import { buildAntigravityRuntimeDescriptorV1 } from '../runtime/runtimeDescriptor.js';

describe('Antigravity terminal launch arguments', () => {
  it('builds descriptor-derived continuation and host-selected model flags', () => {
    expect(buildAntigravityTerminalLaunchArgs({
      conversationId: 'conv-123',
      modelId: 'Gemini 3.5 Flash (High)',
    })).toEqual([
      '--conversation',
      'conv-123',
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

  it('uses its bounded runtime descriptor for terminal continuation and ignores raw terminal metadata', () => {
    expect(resolveAntigravityTerminalLaunchArgsInput({
      runtimeDescriptorV1: buildAntigravityRuntimeDescriptorV1({
        runtimeMode: 'cliPrint',
        providerSessionId: 'conversation-current',
      }),
      providerSessionId: 'legacy-host-identity',
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
});
