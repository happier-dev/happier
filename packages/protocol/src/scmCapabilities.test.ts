import { describe, expect, it } from 'vitest';

import {
  createGitScmCapabilities,
  createSaplingScmCapabilities,
  createScmCapabilities,
} from './scmCapabilities.js';

describe('scmCapabilities', () => {
  it('creates working-copy defaults when no input is provided', () => {
    const capabilities = createScmCapabilities();
    expect(capabilities.changeSetModel).toBe('working-copy');
    expect(capabilities.supportedDiffAreas).toEqual(['pending', 'both']);
    expect(capabilities.writeCommit).toBe(false);
  });

  it('creates git capability defaults', () => {
    const capabilities = createGitScmCapabilities();
    expect(capabilities.changeSetModel).toBe('index');
    expect(capabilities.supportedDiffAreas).toEqual(['included', 'pending', 'both']);
    expect(capabilities.writeInclude).toBe(true);
  });

  it('creates sapling capability defaults', () => {
    const capabilities = createSaplingScmCapabilities();
    expect(capabilities.changeSetModel).toBe('working-copy');
    expect(capabilities.supportedDiffAreas).toEqual(['pending', 'both']);
    expect(capabilities.writeInclude).toBe(false);
  });
});
