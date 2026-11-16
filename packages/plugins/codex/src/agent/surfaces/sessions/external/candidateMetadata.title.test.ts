import { describe, expect, it } from 'vitest';

import { readCodexExternalSessionTitleCandidate } from '../../../rollout/discovery/rolloutTitle.js';
import { readCodexNativeCandidateTitle } from './candidateMetadata.js';

// A Happier-started Codex thread's first prompt carries the per-send delivery frame; a title is the person's words.
const FRAMED = '<happier_input_context v="1">\nsource_kind="happierApp"\n</happier_input_context>\nFix the login redirect';

describe('Codex external session titles', () => {
  it('titles a thread by its visible first prompt, without the delivery frame', () => {
    expect(readCodexNativeCandidateTitle({ preview: FRAMED })).toBe('Fix the login redirect');
  });

  it('titles a rollout by its visible first prompt, without the delivery frame', () => {
    expect(readCodexExternalSessionTitleCandidate(FRAMED, { source: 'prompt' })).toBe('Fix the login redirect');
  });

  it('keeps a native thread name as the person wrote it', () => {
    expect(readCodexNativeCandidateTitle({ name: 'Release notes', preview: FRAMED })).toBe('Release notes');
  });
});
