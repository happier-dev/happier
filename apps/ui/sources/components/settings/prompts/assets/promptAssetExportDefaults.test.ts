import { describe, expect, it } from 'vitest';

import { defaultPromptAssetTargetInput } from './promptAssetExportDefaults';

describe('defaultPromptAssetTargetInput', () => {
  it('uses a markdown path for doc assets', () => {
    expect(defaultPromptAssetTargetInput({ libraryKind: 'doc', title: 'review/code' })).toBe('review/code.md');
  });

  it('slugifies bundle titles for skill exports', () => {
    expect(defaultPromptAssetTargetInput({ libraryKind: 'bundle', title: 'Code Reviewer' })).toBe('code-reviewer');
  });
});
