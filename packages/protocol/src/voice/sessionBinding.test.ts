import { describe, expect, it } from 'vitest';

import {
  HAPPIER_VOICE_BINDING_NONCE_DYNAMIC_VARIABLE,
  HAPPIER_VOICE_LEASE_ID_DYNAMIC_VARIABLE,
} from './sessionBinding.js';

describe('voice session binding dynamic variables', () => {
  it('publishes stable provider dynamic-variable names', () => {
    expect(HAPPIER_VOICE_BINDING_NONCE_DYNAMIC_VARIABLE).toBe('happier_voice_binding_nonce');
    expect(HAPPIER_VOICE_LEASE_ID_DYNAMIC_VARIABLE).toBe('happier_voice_lease_id');
  });
});
