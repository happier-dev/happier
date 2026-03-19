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
    expect(capabilities.writeDiscard).toBe(false);
    expect(capabilities.readBranches).toBe(false);
    expect(capabilities.writeBranchCreate).toBe(false);
    expect(capabilities.writeBranchCheckout).toBe(false);
    expect(capabilities.writeRemotePublish).toBe(false);
    expect(capabilities.readStash).toBe(false);
    expect(capabilities.writeStash).toBe(false);
  });

  it('creates git capability defaults', () => {
    const capabilities = createGitScmCapabilities();
    expect(capabilities.changeSetModel).toBe('index');
    expect(capabilities.supportedDiffAreas).toEqual(['included', 'pending', 'both']);
    expect(capabilities.writeInclude).toBe(true);
    expect(capabilities.writeDiscard).toBe(true);
    expect(capabilities.readBranches).toBe(true);
    expect(capabilities.writeBranchCreate).toBe(true);
    expect(capabilities.writeBranchCheckout).toBe(true);
    expect(capabilities.writeRemotePublish).toBe(true);
    expect(capabilities.readStash).toBe(true);
    expect(capabilities.writeStash).toBe(true);
  });

  it('creates sapling capability defaults', () => {
    const capabilities = createSaplingScmCapabilities();
    expect(capabilities.changeSetModel).toBe('working-copy');
    expect(capabilities.supportedDiffAreas).toEqual(['pending', 'both']);
    expect(capabilities.writeInclude).toBe(false);
    expect(capabilities.writeDiscard).toBe(true);
    expect(capabilities.readBranches).toBe(false);
    expect(capabilities.writeBranchCreate).toBe(false);
    expect(capabilities.writeBranchCheckout).toBe(false);
    expect(capabilities.writeRemotePublish).toBe(false);
    expect(capabilities.readStash).toBe(false);
    expect(capabilities.writeStash).toBe(false);
  });
});
