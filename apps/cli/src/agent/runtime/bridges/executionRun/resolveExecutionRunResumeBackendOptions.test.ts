import { describe, expect, it } from 'vitest';

import {
  ProviderBoundModelRefSchema,
  type ConnectedServiceBindingsV1,
} from '@happier-dev/protocol';

import type { ExecutionRunState } from './executionRunTypes';
import { resolveExecutionRunResumeBackendOptions } from './resolveExecutionRunResumeBackendOptions';

const CONNECTED_SELECTION: ConnectedServiceBindingsV1 = {
  v: 1,
  bindingsByServiceId: {
    'openai-codex': { source: 'connected', selection: 'profile', profileId: 'team' },
  },
};

const OVERRIDES = {
  v: 1 as const,
  updatedAt: 1,
  overrides: { reasoning_effort: { updatedAt: 1, value: 'high' } },
};

const MODEL_SELECTION = ProviderBoundModelRefSchema.parse({
  agentTargetKey: 'backend:codex',
  providerConnectionId: 'pc_openai',
  modelId: 'gpt-5.5',
});

function baseRun(launch: ExecutionRunState['launch']): ExecutionRunState {
  return {
    runId: 'run_1',
    callId: 'call_1',
    sidechainId: 'sc_1',
    sessionId: 'sess_1',
    depth: 0,
    intent: 'delegate',
    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    backendId: 'codex',
    instructions: '',
    permissionMode: 'read_only',
    retentionPolicy: 'resumable',
    runClass: 'long_lived',
    ioMode: 'request_response',
    status: 'cancelled',
    startedAtMs: 1,
    ...(launch ? { launch } : {}),
  };
}

describe('resolveExecutionRunResumeBackendOptions', () => {
  it('rehydrates the exact model selection, config overrides, and SAME persisted CS selection', () => {
    const options = resolveExecutionRunResumeBackendOptions({
      run: baseRun({
        modelId: 'gpt-5.5',
        modelSelection: MODEL_SELECTION,
        sessionConfigOptionOverrides: OVERRIDES,
        connectedServicesSelection: CONNECTED_SELECTION,
      }),
    });
    expect(options.modelId).toBe('gpt-5.5');
    expect(options.modelSelection).toEqual(MODEL_SELECTION);
    expect(options.sessionConfigOptionOverrides).toEqual(OVERRIDES);
    // The persisted selection is authoritative on resume — the daemon re-materializes it verbatim.
    expect(options.connectedServices).toEqual(CONNECTED_SELECTION);
  });

  it('carries a persisted native (opt-out) selection through so resume honors the opt-out explicitly', () => {
    const nativeSelection: ConnectedServiceBindingsV1 = {
      v: 1,
      bindingsByServiceId: { 'openai-codex': { source: 'native' } },
    };
    const options = resolveExecutionRunResumeBackendOptions({
      run: baseRun({ connectedServicesSelection: nativeSelection }),
    });
    expect(options.connectedServices).toEqual(nativeSelection);
  });

  it('omits connectedServices when the launch record had no connected selection', () => {
    const options = resolveExecutionRunResumeBackendOptions({
      run: baseRun({ modelId: 'gpt-5.5' }),
    });
    expect(options.modelId).toBe('gpt-5.5');
    expect(options.connectedServices).toBeUndefined();
    expect(options.sessionConfigOptionOverrides).toBeUndefined();
  });

  it('returns empty options when there is no launch record (or no run)', () => {
    expect(resolveExecutionRunResumeBackendOptions({ run: baseRun(undefined) })).toEqual({});
    expect(resolveExecutionRunResumeBackendOptions({ run: null })).toEqual({});
  });
});
