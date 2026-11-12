import { describe, expect, it } from 'vitest';
import { PluginError } from '../errors.js';
import { projectMachineProvisionerActionFailure } from './actionFailure.js';

describe('projectMachineProvisionerActionFailure', () => {
  it.each(['direct', 'nativeCause'] as const)('preserves the published PluginError envelope for the Action owner through %s', carrier => {
    const error = new PluginError({ code: 'credential_unavailable', message: 'Sign in to Docker: run sbx login',
      retryable: true, details: { nativeCause: { localCause: 'not_signed_in' } }, remediation: { kind: 'retry' } });
    const thrown = carrier === 'direct' ? error : new Error('native inspection unavailable', { cause: error });
    expect(() => projectMachineProvisionerActionFailure(thrown, () => 'fallback')).toThrow(error);
  });

  it.each(['direct', 'nativeCause'] as const)('keeps an operation-specific fallback for an untyped native failure through %s', carrier => {
    const error = new Error('native');
    const thrown = carrier === 'direct' ? error : new Error('native inspection unavailable', { cause: error });
    expect(projectMachineProvisionerActionFailure(thrown, () => 'fallback')).toBe('fallback');
  });
});
