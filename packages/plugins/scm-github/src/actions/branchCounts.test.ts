import { describe, expect, it } from 'vitest';
import type { PluginResourceContextV1 } from '@happier-dev/plugin-sdk/resources';
import { projectGithubCiBranchCountInputV1 } from './branchCounts.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { GITHUB_ACTIONS_PAGE_ID_V1, GITHUB_SESSION_CI_VIEW_ID_V1 } from '../ui/forge/surfaceIds.js';

const repository = { kind: 'github', deployment: 'https://github.com', repository: 'acme/widgets' } as const;
const headOid = 'a'.repeat(40);

describe('GitHub recent branch count input', () => {
  it('declares one ordered labelled atomic Resource for Actions and Session CI', () => {
    const views = PLUGIN_MANIFEST.contributes.ui?.views ?? [];
    for (const id of [GITHUB_ACTIONS_PAGE_ID_V1, GITHUB_SESSION_CI_VIEW_ID_V1]) {
      expect(views.find(view => view.id === id)).toMatchObject({
        counts: { resourceId: 'ci-branch-counts', items: [
          { field: 'running', label: expect.objectContaining({ key: expect.any(String) }) },
          { field: 'failed', label: expect.objectContaining({ key: expect.any(String) }) },
        ] },
      });
    }
    expect(PLUGIN_MANIFEST.contributes.resources?.filter(resource => resource.id === 'ci-branch-counts')).toEqual([
      expect.objectContaining({ source: 'dynamic', scope: 'surface', contentType: 'application/json' }),
    ]);
  });
  it('uses the host-stamped current Project branch without borrowing surface launch input', () => {
    const context = {
      kind: 'surface', mountInstanceKey: 'project-actions',
      launchInput: { branch: 'wrong-branch', headOid: 'b'.repeat(40) },
      target: { kind: 'project', projectKey: 'project-a', repository, branch: 'feature/ci' },
    } as const satisfies PluginResourceContextV1;
    expect(projectGithubCiBranchCountInputV1(context)).toEqual({ repository, filters: { branch: 'feature/ci' } });
  });

  it('narrows a Session to both its current branch and exact HEAD, including after HEAD moves', () => {
    const context = { kind: 'session', sessionId: 'session-a',
      target: { kind: 'session', sessionId: 'session-a', repository, branch: 'feature/ci', headOid },
    } as const satisfies PluginResourceContextV1;
    expect(projectGithubCiBranchCountInputV1(context)).toEqual({ repository, filters: { branch: 'feature/ci', headSha: headOid } });
    const moved = { ...context, target: { ...context.target, headOid: 'b'.repeat(40) } };
    expect(projectGithubCiBranchCountInputV1(moved)).toEqual({ repository, filters: { branch: 'feature/ci', headSha: moved.target.headOid } });
  });

  it('uses the same surface-scoped Resource for a Session target without opening its rail body', () => {
    const context = { kind: 'surface', mountInstanceKey: 'session-ci-counts', launchInput: null,
      target: { kind: 'session', sessionId: 'session-a', repository, branch: 'feature/ci', headOid },
    } as const satisfies PluginResourceContextV1;
    expect(projectGithubCiBranchCountInputV1(context)).toEqual({ repository, filters: { branch: 'feature/ci', headSha: headOid } });
  });

  it('retains equal query operands at the producer, but never reuses a different branch or HEAD', () => {
    const context = { kind: 'surface', mountInstanceKey: 'session-ci-counts', launchInput: null,
      target: { kind: 'session', sessionId: 'session-a', repository, branch: 'feature/ci', headOid },
    } as const satisfies PluginResourceContextV1;
    const previous = projectGithubCiBranchCountInputV1(context);
    expect(projectGithubCiBranchCountInputV1(structuredClone(context), previous)).toBe(previous);
    expect(projectGithubCiBranchCountInputV1({ ...context, target: { ...context.target, branch: 'other' } }, previous)).not.toBe(previous);
    expect(projectGithubCiBranchCountInputV1({ ...context, target: { ...context.target, headOid: 'b'.repeat(40) } }, previous)).not.toBe(previous);
  });

  it('withholds demand when an accepted target is absent instead of guessing from launch input or Session id', () => {
    const contexts: readonly PluginResourceContextV1[] = [
      { kind: 'global' },
      { kind: 'session', sessionId: 'session-a' },
      { kind: 'surface', mountInstanceKey: 'project-actions', launchInput: { repository, branch: 'feature/ci', headOid } },
      { kind: 'surface', mountInstanceKey: 'app-page', launchInput: null, target: { kind: 'app' } },
      { kind: 'surface', mountInstanceKey: 'project-actions', launchInput: null,
        target: { kind: 'project', projectKey: 'project-a', branch: 'feature/ci' } },
      { kind: 'surface', mountInstanceKey: 'project-actions', launchInput: null,
        target: { kind: 'project', projectKey: 'project-a', repository } },
      { kind: 'surface', mountInstanceKey: 'session-ci-counts', launchInput: null,
        target: { kind: 'session', sessionId: 'session-a', repository, branch: 'feature/ci' } },
    ];
    for (const context of contexts) expect(projectGithubCiBranchCountInputV1(context)).toBeNull();
  });

  it('does not widen a Session whose accepted OID cannot be queried as a GitHub commit', () => {
    const context = { kind: 'session', sessionId: 'session-a',
      target: { kind: 'session', sessionId: 'session-a', repository, branch: 'feature/ci', headOid: 'abc123' },
    } as const satisfies PluginResourceContextV1;
    expect(projectGithubCiBranchCountInputV1(context)).toBeNull();
  });

  it('keeps another forge or GitHub deployment out of the github.com acquisition', () => {
    for (const otherRepository of [
      { ...repository, kind: 'gitlab', deployment: 'https://gitlab.com' },
      { ...repository, deployment: 'https://github.example.test' },
    ] as const) {
      const context = { kind: 'surface', mountInstanceKey: 'project-actions', launchInput: null,
        target: { kind: 'project', projectKey: 'project-a', repository: otherRepository, branch: 'feature/ci' },
      } satisfies PluginResourceContextV1;
      expect(projectGithubCiBranchCountInputV1(context)).toBeNull();
    }
  });
});
