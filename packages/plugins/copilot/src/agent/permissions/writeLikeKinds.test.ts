import { describe, expect, it } from 'vitest';

import { COPILOT_WRITE_LIKE_PERMISSION_KINDS } from './writeLikeKinds.js';

describe('Copilot write-like permission vocabulary', () => {
  it('keeps only the provider vocabulary leaf in the plugin', () => {
    expect(COPILOT_WRITE_LIKE_PERMISSION_KINDS).toEqual(['external_directory', 'doom_loop']);
  });
});
