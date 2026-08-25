import { describe, expect, it } from 'vitest';

import { buildGithubFixCiSessionSeed, requestGithubFixCiSession } from './fixCi.js';

describe('the GitHub Fix CI Session handoff', () => {
  it('uses failed output evidence and never substitutes the check name', () => {
    const seed = buildGithubFixCiSessionSeed({
      repository: 'octo-org/example-app',
      headRevision: '9f2c1a7d',
      check: {
        key: 'github-check-run:9003',
        resourceKind: 'check-run',
        name: 'build',
        status: 'completed',
        conclusion: 'failure',
        logExcerpt: 'Typecheck found 2 errors in src/pump.ts.',
      },
    });

    expect(seed?.prompt.text).toContain('Typecheck found 2 errors in src/pump.ts.');
    expect(seed?.prompt.text).toContain('9f2c1a7d');
    expect(buildGithubFixCiSessionSeed({
      repository: 'octo-org/example-app',
      headRevision: '9f2c1a7d',
      check: {
        key: 'github-check-run:9004',
        resourceKind: 'check-run',
        name: 'build',
        status: 'completed',
        conclusion: 'failure',
      },
    })).toBeNull();
  });

  it('reports only the host seeded settlement as success', async () => {
    const seed = { prompt: { text: 'diagnose this log', mode: 'replace' as const } };
    await expect(requestGithubFixCiSession({
      version: () => ({ methods: ['selectActionInput'] }),
      selectActionInput: async () => ({ kind: 'serverStartDraft' }),
    }, seed)).resolves.toEqual({ status: 'unavailable' });
    await expect(requestGithubFixCiSession({
      version: () => ({ methods: ['selectActionInput'] }),
      selectActionInput: async () => ({ kind: 'newSessionSeeded' }),
    }, seed)).resolves.toEqual({ status: 'seeded' });
  });
});
