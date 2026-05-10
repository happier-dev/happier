import { describe, expect, it } from 'vitest';

import { withGitlabCliTempBody } from './gitlabCliTempBody.js';

describe('GitLab CLI temporary MR body handling', () => {
  it('passes a file reference and cleans up after success', async () => {
    const events: string[] = [];
    const result = await withGitlabCliTempBody(
      'Sensitive MR body',
      async (fieldArg) => {
        events.push(`callback:${fieldArg}`);
        expect(fieldArg).toMatch(/^description=@\/tmp\/gitlab-mr-test\/description\.md$/);
        expect(fieldArg).not.toContain('Sensitive MR body');
        return 'ok';
      },
      {
        makeTempDir: async () => {
          events.push('makeTempDir');
          return '/tmp/gitlab-mr-test';
        },
        writeBodyFile: async (path, body) => {
          events.push(`write:${path}:${body}`);
        },
        removeTempDir: async (path) => {
          events.push(`remove:${path}`);
        },
      },
    );

    expect(result).toBe('ok');
    expect(events).toEqual([
      'makeTempDir',
      'write:/tmp/gitlab-mr-test/description.md:Sensitive MR body',
      'callback:description=@/tmp/gitlab-mr-test/description.md',
      'remove:/tmp/gitlab-mr-test',
    ]);
  });

  it('cleans up after command failure without masking the primary error', async () => {
    const events: string[] = [];
    await expect(withGitlabCliTempBody(
      'Sensitive MR body',
      async () => {
        events.push('callback');
        throw new Error('primary command failure');
      },
      {
        makeTempDir: async () => '/tmp/gitlab-mr-test',
        writeBodyFile: async () => undefined,
        removeTempDir: async (path) => {
          events.push(`remove:${path}`);
          throw new Error('cleanup failure');
        },
      },
    )).rejects.toThrow('primary command failure');

    expect(events).toEqual(['callback', 'remove:/tmp/gitlab-mr-test']);
  });
});
