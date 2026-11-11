import { describe, expect, it } from 'vitest';
import { PluginError } from '../errors.js';
import { projectMachineProvisionerActionFailure } from './actionFailure.js';

describe('projectMachineProvisionerActionFailure', () => {
  it('preserves the published PluginError envelope for the Action owner', () => {
    const error = new PluginError({ code: 'credential_unavailable', message: 'Sign in to Docker: run sbx login',
      retryable: true, details: { nativeCause: { localCause: 'not_signed_in' } }, remediation: { kind: 'retry' } });
    expect(() => projectMachineProvisionerActionFailure(error, () => 'fallback')).toThrow(error);
  });

  it('keeps an operation-specific fallback only for an untyped native failure', () => {
    expect(projectMachineProvisionerActionFailure(new Error('native'), () => 'fallback')).toBe('fallback');
  });
});
