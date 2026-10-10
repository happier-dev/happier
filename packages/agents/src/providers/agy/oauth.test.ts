import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { AGY_OAUTH_CLIENT_ID, AGY_OAUTH_CLIENT_SECRET } from './oauth.js';

describe('Antigravity native OAuth configuration', () => {
  it('preserves the official ACP issuer used by existing connected accounts', () => {
    // Fingerprints of the public client configuration in official ACP v1.1.1.
    // Changing either value would break authorization and saved-account refresh.
    expect(createHash('sha256').update(AGY_OAUTH_CLIENT_ID).digest('hex')).toBe(
      'bf00c418024ba6bf606ccdc37120976e41bc429dd1d46ecf16a729aa532626ea',
    );
    expect(createHash('sha256').update(AGY_OAUTH_CLIENT_SECRET).digest('hex')).toBe(
      '1d2f041093fd95aa8995a038c711d50a7960da09a505381c09a745d6ad0ecc60',
    );
  });
});
