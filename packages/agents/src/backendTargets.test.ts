import { describe, expect, it } from 'vitest';

import {
  BackendTargetRefSchema,
  buildBackendTargetKey,
  isBuiltInAgentTarget,
  isConfiguredAcpBackendTarget,
} from './backendTargets.js';

describe('agents backendTargets', () => {
  it('re-exports the canonical backend target contract from protocol', () => {
    const builtIn = BackendTargetRefSchema.parse({ kind: 'builtInAgent', agentId: 'kiro' });
    const configured = BackendTargetRefSchema.parse({ kind: 'configuredAcpBackend', backendId: 'review' });

    expect(isBuiltInAgentTarget(builtIn)).toBe(true);
    expect(isConfiguredAcpBackendTarget(configured)).toBe(true);
    expect(buildBackendTargetKey(builtIn)).toBe('agent:kiro');
    expect(buildBackendTargetKey(configured)).toBe('acpBackend:review');
  });

  it('keeps legacy customAcp placeholders out of the re-exported backend target contract', () => {
    expect(() => BackendTargetRefSchema.parse({ kind: 'builtInAgent', agentId: 'customAcp' })).toThrow();
    expect(() => BackendTargetRefSchema.parse({ kind: 'configuredAcpBackend', backendId: 'customAcp' })).toThrow();
  });
});
