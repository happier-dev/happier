import { describe, expect, it } from 'vitest';

import { AUGGIE_ACP_RUNTIME_DEFINITION } from './definition.js';

describe('Auggie ACP runtime definition', () => {
  it('delegates authentication classification to the host while retaining provider guidance', () => {
    expect(AUGGIE_ACP_RUNTIME_DEFINITION.stderrRules).toEqual({
      authenticationErrorDetail: 'Authentication error. Run `auggie login` or set AUGMENT_SESSION_AUTH in your environment.',
    });
  });
});
