import { describe, expect, it } from 'vitest';

import {
  BackendTargetRefSchema,
  buildBackendTargetKey,
  isBuiltInAgentTarget,
  isConfiguredAcpBackendTarget,
} from './backendTargets.js';

describe('agents backendTargets', () => {
  it('re-exports the canonical backend target contract from protocol', () => {
    const builtIn = BackendTargetRefSchema.parse({ kind: 'builtInAgent', agentId: 'customAcp' });
    const configured = BackendTargetRefSchema.parse({ kind: 'configuredAcpBackend', backendId: 'review' });

    expect(isBuiltInAgentTarget(builtIn)).toBe(true);
    expect(isConfiguredAcpBackendTarget(configured)).toBe(true);
    expect(buildBackendTargetKey(builtIn)).toBe('agent:customAcp');
    expect(buildBackendTargetKey(configured)).toBe('acpBackend:review');
  });
});
