import { describe, expect, it } from 'vitest';

import {
  BackendTargetKeySchema,
  BackendTargetKindSchema,
  BackendTargetRefSchema,
  buildBackendTargetKey,
  isBuiltInAgentTarget,
  isConfiguredAcpBackendTarget,
  parseBackendTargetKey,
} from './backendTargetRef.js';

describe('backendTargetRef', () => {
  it('parses built-in agent targets', () => {
    const parsed = BackendTargetRefSchema.parse({ kind: 'builtInAgent', agentId: 'kiro' });

    expect(parsed).toEqual({ kind: 'builtInAgent', agentId: 'kiro' });
    expect(isBuiltInAgentTarget(parsed)).toBe(true);
    expect(isConfiguredAcpBackendTarget(parsed)).toBe(false);
    expect(buildBackendTargetKey(parsed)).toBe('agent:kiro');
  });

  it('parses configured ACP backend targets', () => {
    const parsed = BackendTargetRefSchema.parse({ kind: 'configuredAcpBackend', backendId: 'backend_1' });

    expect(parsed).toEqual({ kind: 'configuredAcpBackend', backendId: 'backend_1' });
    expect(isConfiguredAcpBackendTarget(parsed)).toBe(true);
    expect(isBuiltInAgentTarget(parsed)).toBe(false);
    expect(buildBackendTargetKey(parsed)).toBe('acpBackend:backend_1');
  });

  it('rejects mismatched payload shapes', () => {
    expect(() => BackendTargetRefSchema.parse({ kind: 'builtInAgent', backendId: 'backend_1' })).toThrow();
    expect(() => BackendTargetRefSchema.parse({ kind: 'configuredAcpBackend', agentId: 'kiro' })).toThrow();
  });

  it('validates canonical target key prefixes', () => {
    expect(BackendTargetKindSchema.parse('builtInAgent')).toBe('builtInAgent');
    expect(BackendTargetKeySchema.parse('agent:claude')).toBe('agent:claude');
    expect(BackendTargetKeySchema.parse('acpBackend:team-review')).toBe('acpBackend:team-review');
    expect(() => BackendTargetKeySchema.parse('kiro')).toThrow();
  });

  it('parses canonical target keys back into target refs', () => {
    expect(parseBackendTargetKey('agent:claude')).toEqual({ kind: 'builtInAgent', agentId: 'claude' });
    expect(parseBackendTargetKey('acpBackend:team-review')).toEqual({
      kind: 'configuredAcpBackend',
      backendId: 'team-review',
    });
    expect(() => parseBackendTargetKey('claude')).toThrow();
  });
});
