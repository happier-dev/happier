import { describe, expect, it } from 'vitest';
import { RegistryStarterV1Schema } from './registryStarterV1.js';

const starter = {
  repository: 'https://github.com/mdn/beginner-html-site-styled',
  title: 'Static website', description: 'An HTML website', tags: ['website'], buildGoal: 'Build the website.',
};

describe('whole-repository starters', () => {
  it('accepts a repository without a pinned revision and rejects subdirectory materialization', () => {
    expect(RegistryStarterV1Schema.safeParse(starter).success).toBe(true);
    expect(RegistryStarterV1Schema.safeParse({ ...starter, path: 'examples/site' }).success).toBe(false);
  });
  it.each(['https://user:secret@github.com/example/starter', 'https://github.com/example/starter?token=secret'])(
    'rejects credential-bearing repository locators: %s', repository => {
      expect(RegistryStarterV1Schema.safeParse({ ...starter, repository }).success).toBe(false);
    });
});
