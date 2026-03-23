import { describe, expect, it } from 'vitest';

import * as acpRuntimeOverrideSynchronizers from './createAcpRuntimeOverrideSynchronizers';

describe('createRuntimeOverrideSynchronizers exports', () => {
  it('exposes the canonical export while keeping the ACP alias', () => {
    expect(typeof acpRuntimeOverrideSynchronizers.createRuntimeOverrideSynchronizers).toBe('function');
    expect(acpRuntimeOverrideSynchronizers.createAcpRuntimeOverrideSynchronizers).toBe(
      acpRuntimeOverrideSynchronizers.createRuntimeOverrideSynchronizers,
    );
  });
});
