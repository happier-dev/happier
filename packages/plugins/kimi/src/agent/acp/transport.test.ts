import { describe, expect, it } from 'vitest';

import { KIMI_ACP_RUNTIME_DEFINITION } from './definition.js';

describe('Kimi ACP stderr rules', () => {
  it('delegates authentication classification to the host while retaining provider guidance', () => {
    expect(KIMI_ACP_RUNTIME_DEFINITION.stderrRules).toEqual({
      authenticationErrorDetail: 'Authentication error. Run `kimi login` to re-authenticate, then retry.',
    });
  });
});
