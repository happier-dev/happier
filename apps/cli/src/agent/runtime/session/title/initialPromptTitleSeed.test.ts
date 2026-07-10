import { describe, expect, it } from 'vitest';

import {
  applyInitialPromptTitleSeedToMetadata,
  deriveInitialPromptTitleSeed,
} from './initialPromptTitleSeed';

describe('initialPromptTitleSeed', () => {
  it('derives a bounded first-line title seed without carrying multiline prompt text', () => {
    expect(deriveInitialPromptTitleSeed('  Inspect this repo and summarize the modules\nInclude tests.  '))
      .toBe('Inspect this repo and summarize the modules');
  });

  it('writes the title seed through the canonical display.title metadata binding', () => {
    expect(applyInitialPromptTitleSeedToMetadata({ path: '/repo' } as any, 'Inspect repo')).toMatchObject({
      summary: {
        text: 'Inspect repo',
      },
    });
  });

  it('does not overwrite an existing canonical display title', () => {
    const metadata = {
      summary: {
        text: 'Existing title',
        updatedAt: 123,
      },
    } as any;

    expect(applyInitialPromptTitleSeedToMetadata(metadata, 'Prompt seed')).toBe(metadata);
  });
});
