import { describe, expect, it } from 'vitest';

import {
  RUNTIME_CHECKPOINT_TOOL_PROTOCOLS_V1,
  resolveRuntimeCheckpointToolProtocol,
} from './checkpoints.js';

describe('session checkpoint controls', () => {
  it('resolves a provider-neutral checkpoint tool protocol from runtime config', () => {
    expect(RUNTIME_CHECKPOINT_TOOL_PROTOCOLS_V1).toEqual(['acp', 'claude', 'codex']);
    expect(resolveRuntimeCheckpointToolProtocol('claude')).toBe('claude');
    expect(resolveRuntimeCheckpointToolProtocol('codex')).toBe('codex');
    expect(resolveRuntimeCheckpointToolProtocol('acp')).toBe('acp');
  });

  it('fails closed to acp for missing or unknown runtime config', () => {
    expect(resolveRuntimeCheckpointToolProtocol(undefined)).toBe('acp');
    expect(resolveRuntimeCheckpointToolProtocol(null)).toBe('acp');
    expect(resolveRuntimeCheckpointToolProtocol('opencode')).toBe('acp');
    expect(resolveRuntimeCheckpointToolProtocol({ protocol: 'codex' })).toBe('acp');
  });
});
