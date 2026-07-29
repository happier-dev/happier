import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('voice surface E2E fixture provider boundary', () => {
  it('treats provider identities as scenario data instead of branching on bundled provider ids', async () => {
    const source = await readFile('sources/dev/testkit/harness/useVoiceSurfaceE2eFixtureComposition.ts', 'utf8');

    expect(source).not.toMatch(
      /(?:providerId|adapterId|bindingAdapterId)\s*(?:===|!==)\s*['"](?:realtime_elevenlabs|local_conversation)['"]/,
    );
  });
});
