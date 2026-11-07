import { describe, expect, it } from 'vitest';
import { projectGithubSessionCiContextV1, projectGithubOverviewCiContextV1, githubRailLocalRunIntentV1 } from './ciContext.js';
import type { ForgeCiRunV1 } from '@happier-dev/triage-protocol/ci/v1';

const repository = { kind: 'github', deployment: 'https://github.com', repository: 'acme/widgets' } as const;
const sha = 'a'.repeat(40);
const branch = { head: 'topic', headOid: sha, upstream: 'origin/topic', upstreamOid: sha, ahead: 0, behind: 0, detached: false };
const run: ForgeCiRunV1 = { ref: { v: 1, repository, runId: '81' }, headSha: sha, headRef: 'topic',
  state: { phase: 'completed', outcome: 'failure', outcomeBucket: 'failed', nativeLabel: 'failure' },
  workflow: { id: '12', path: '.github/workflows/ci.yml' } };

describe('Session and Overview CI context', () => {
  it('scopes Session CI to both the current branch and exact pushed HEAD', () => {
    const context = projectGithubSessionCiContextV1(null, { repository, branch });
    expect(context).toMatchObject({ kind: 'ready', scope: 'session', input: { repository, filters: { branch: 'topic', headSha: sha } } });
    expect(projectGithubSessionCiContextV1(context, { repository: { ...repository }, branch: { ...branch } })).toBe(context);
    const moved = projectGithubSessionCiContextV1(context, { repository, branch: { ...branch, headOid: 'b'.repeat(40), upstreamOid: 'b'.repeat(40) } });
    expect(moved).not.toBe(context);
    expect(moved).toMatchObject({ input: { filters: { headSha: 'b'.repeat(40) } } });
  });

  it.each([
    [{ ...branch, detached: true }, 'detached'],
    [{ ...branch, ahead: 1 }, 'unpushed'],
    [{ ...branch, upstream: null }, 'unpushed'],
    [{ ...branch, headOid: undefined }, 'unknown'],
  ] as const)('withholds hosted demand for %j', (branch, kind) => {
    expect(projectGithubSessionCiContextV1(null, { repository, branch })).toMatchObject({ kind });
    expect(projectGithubSessionCiContextV1(null, { repository, branch })).not.toHaveProperty('input');
  });

  it('uses default-branch HEAD for Overview even when the Session is on another branch', () => {
    const overview = projectGithubOverviewCiContextV1(null, { repository, defaultBranch: 'main', headSha: 'c'.repeat(40) });
    expect(overview).toMatchObject({ kind: 'ready', scope: 'overview', input: { filters: { branch: 'main', headSha: 'c'.repeat(40) } } });
    expect(projectGithubOverviewCiContextV1(null, { repository, defaultBranch: 'main', headSha: null })).toMatchObject({ kind: 'unknown' });
  });

  it('opens only the selected current-HEAD failed subject through the existing safe local form', () => {
    const context = projectGithubSessionCiContextV1(null, { repository, branch });
    const workspace = { serverId: 'home-1', workspaceId: 'checkout-1', machineId: 'machine-1', rootPath: '/work/widgets' };
    expect(githubRailLocalRunIntentV1(context, run, workspace, 'session-a6')).toEqual({ operation: { kind: 'open', seed: { target: { kind: 'session', sessionId: 'session-a6' }, workspace,
      workflowPath: '.github/workflows/ci.yml', sourceHeadSha: sha } } });
    expect(githubRailLocalRunIntentV1(context, { ...run, headSha: 'b'.repeat(40) }, workspace, 'session-a6')).toBeNull();
    expect(githubRailLocalRunIntentV1(context, run, null, 'session-a6')).toBeNull();
    expect(githubRailLocalRunIntentV1(context, { ...run, ref: { ...run.ref, repository: { ...repository, repository: 'acme/other' } } }, workspace, 'session-a6')).toBeNull();
  });
});
