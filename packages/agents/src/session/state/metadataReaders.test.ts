import { describe, expect, it } from 'vitest';

import {
  isProviderBoundSessionMetadata,
  readActiveSessionModelSelectionFromMetadata,
  resolveModelSelectionIntentFromSessionMetadata,
} from './metadataReaders.js';

describe('isProviderBoundSessionMetadata', () => {
  function intent(selection: unknown): Record<string, unknown> {
    return { modelSelectionIntentV1: { v: 1, updatedAt: 4, selection } };
  }

  it('reports a canonical intent that names a Provider connection', () => {
    expect(isProviderBoundSessionMetadata(intent({
      agentTargetKey: 'backend:codex',
      providerConnectionId: 'pc_work',
      modelId: 'provider-model',
    }))).toBe(true);
  });

  it('does not report a native selection, a cleared intent, or absent metadata', () => {
    expect(isProviderBoundSessionMetadata(intent({
      agentTargetKey: 'backend:codex',
      providerConnectionId: null,
      modelId: 'gpt-5',
    }))).toBe(false);
    expect(isProviderBoundSessionMetadata(intent(null))).toBe(false);
    expect(isProviderBoundSessionMetadata({ flavor: 'codex' })).toBe(false);
    expect(isProviderBoundSessionMetadata(null)).toBe(false);
  });

  it('ignores the legacy override carrier, which cannot express a connection', () => {
    expect(isProviderBoundSessionMetadata({
      modelOverrideV1: { v: 1, updatedAt: 9, modelId: 'legacy-native' },
    })).toBe(false);
  });

  it('stays bound when a newer legacy override sits beside a Provider-bound canonical intent', () => {
    // The shared effective-source rule gives a Provider-bound canonical
    // selection priority over any legacy override however recent, so the
    // key-free read agrees with the target-keyed resolver.
    expect(isProviderBoundSessionMetadata({
      ...intent({
        agentTargetKey: 'backend:codex',
        providerConnectionId: 'pc_work',
        modelId: 'provider-model',
      }),
      modelOverrideV1: { v: 1, updatedAt: 99, modelId: 'legacy-native' },
    })).toBe(true);
  });

  it('fails closed on a malformed intent that still declares a connection', () => {
    expect(isProviderBoundSessionMetadata({
      modelSelectionIntentV1: { selection: { providerConnectionId: 'pc_work' } },
    })).toBe(true);
  });
});

describe('resolveModelSelectionIntentFromSessionMetadata', () => {
  it('normalizes legacy input only after the exact target is supplied', () => {
    expect(resolveModelSelectionIntentFromSessionMetadata({
      modelOverrideV1: { v: 1, updatedAt: 4, modelId: 'legacy-native' },
    }, 'backend:codex')).toEqual({
      v: 1,
      updatedAt: 4,
      selection: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: null,
        modelId: 'legacy-native',
      },
    });
  });

  it('refuses a canonical selection for another target', () => {
    expect(() => resolveModelSelectionIntentFromSessionMetadata({
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 4,
        selection: {
          agentTargetKey: 'backend:claude',
          providerConnectionId: 'pc_work',
          modelId: 'provider-model',
        },
      },
    }, 'backend:codex')).toThrowError(expect.objectContaining({
      code: 'model_selection_agent_target_mismatch',
    }));
  });
});

describe('readActiveSessionModelSelectionFromMetadata', () => {
  const runner = {
    v: 1 as const,
    sessionId: 'session-1',
    machineId: 'machine-1',
    daemonId: 'daemon-1',
    observedAtMs: 1,
    runner: {
      pid: 123,
      processStartTimeMs: 1_000,
      runtimeId: 'same-runner-build',
      cliVersion: '1.0.0',
      entrypointVersion: '1.0.0',
      processCommandHash: 'command-hash',
      entrypointSource: 'launch_spec' as const,
      startedBy: 'daemon' as const,
      startingMode: 'remote' as const,
    },
    daemon: {
      cliVersion: '1.0.0',
      startedWithCliVersion: '1.0.0',
      currentEntrypointVersion: 'same-runner-build',
      currentEntrypointSource: 'launch_spec' as const,
    },
    versionState: 'current' as const,
    statusSource: 'daemon_tracking' as const,
    plannedRestart: {
      supported: true,
      eligible: true,
      disabledReason: null,
    },
  };

  const exactNativeMetadata = {
    sessionRunnerRuntimeV1: runner,
    sessionModelsV1: {
      v: 1 as const,
      agentId: 'antigravity',
      updatedAt: 40,
      currentModelId: 'active-native-model',
      availableModels: [
        { id: 'active-native-model', name: 'Active native model' },
      ],
      activeSelectionV1: {
        v: 1 as const,
        selection: {
          agentTargetKey: 'backend:antigravity',
          providerConnectionId: null,
          modelId: 'active-native-model',
        },
        source: 'runtime_apply' as const,
        runner: {
          pid: 123,
          processStartTimeMs: 1_000,
        },
      },
    },
  };

  it('returns only the exact selection proven for the current physical runner', () => {
    expect(readActiveSessionModelSelectionFromMetadata({
      ...exactNativeMetadata,
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 41,
        selection: {
          agentTargetKey: 'backend:antigravity',
          providerConnectionId: 'pc_next',
          modelId: 'proposed-provider-model',
        },
      },
    }, 'backend:antigravity', {
      pid: 123,
      processStartTimeMs: 1_000,
    })).toEqual({
      agentTargetKey: 'backend:antigravity',
      providerConnectionId: null,
      modelId: 'active-native-model',
    });
  });

  it('does not promote catalog fallback state or pending intent into active proof', () => {
    expect(readActiveSessionModelSelectionFromMetadata({
      sessionModelsV1: {
        v: 1,
        agentId: 'antigravity',
        updatedAt: 40,
        currentModelId: 'fallback-model',
        availableModels: [
          { id: 'fallback-model', name: 'Fallback model' },
        ],
      },
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 41,
        selection: {
          agentTargetKey: 'backend:antigravity',
          providerConnectionId: 'pc_next',
          modelId: 'proposed-provider-model',
        },
      },
    }, 'backend:antigravity', null)).toBeNull();
  });

  it('invalidates old proof after a same-build physical runner replacement', () => {
    expect(readActiveSessionModelSelectionFromMetadata({
      ...exactNativeMetadata,
      sessionRunnerRuntimeV1: {
        ...runner,
        runner: {
          ...runner.runner,
          pid: 456,
          processStartTimeMs: 2_000,
        },
      },
    }, 'backend:antigravity', {
      pid: 456,
      processStartTimeMs: 2_000,
    })).toBeNull();
  });
});
