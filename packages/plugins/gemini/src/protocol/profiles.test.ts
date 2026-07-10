import { describe, expect, it } from 'vitest';

import { GEMINI_BUILT_IN_BACKEND_PROFILES } from './profiles.js';

describe('GEMINI_BUILT_IN_BACKEND_PROFILES', () => {
  it('advertises only API-key and Vertex profiles for the Gemini ACP revival closure', () => {
    expect(GEMINI_BUILT_IN_BACKEND_PROFILES.map((profile) => profile.id)).toEqual([
      'gemini-api-key',
      'gemini-vertex',
    ]);
    expect(GEMINI_BUILT_IN_BACKEND_PROFILES).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ authMode: 'machineLogin' }),
      ]),
    );
  });
});
