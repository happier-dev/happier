import { describe, expect, it } from 'vitest';

import { MachineContentPublicKeyMismatchError } from '@/api/api';

import { shouldRetryMachineRegistrationError } from './machineRegistrationRetryPolicy';

describe('shouldRetryMachineRegistrationError', () => {
  it('returns false for MachineContentPublicKeyMismatchError', () => {
    const error = new MachineContentPublicKeyMismatchError('m1', 'content_public_key_mismatch');
    expect(shouldRetryMachineRegistrationError(error)).toBe(false);
  });

  it('returns true for unknown errors', () => {
    expect(shouldRetryMachineRegistrationError(new Error('network'))).toBe(true);
  });

  it('returns false for 401 authentication errors', () => {
    expect(
      shouldRetryMachineRegistrationError({
        response: { status: 401 },
      }),
    ).toBe(false);
  });

  it('returns false for 403 authentication errors', () => {
    expect(
      shouldRetryMachineRegistrationError({
        response: { status: 403 },
      }),
    ).toBe(false);
  });
});
