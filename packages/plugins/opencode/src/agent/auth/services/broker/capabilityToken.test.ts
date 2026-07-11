import { describe, expect, it } from 'vitest';

import { OPEN_CODE_BROKER_REFRESH_TOKEN_PATH_ENV } from './capabilityToken.js';

describe('OpenCode broker capability path', () => {
  it('uses the shared per-materialization capability-file contract', () => {
    expect(OPEN_CODE_BROKER_REFRESH_TOKEN_PATH_ENV).toBe(
      'HAPPIER_CONNECTED_SERVICE_BROKER_REFRESH_TOKEN_PATH',
    );
  });
});
