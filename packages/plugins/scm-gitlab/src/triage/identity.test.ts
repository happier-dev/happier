import { describe, expect, it } from 'vitest';

import mergeRequestList from './__fixtures__/mergeRequestList.json' with { type: 'json' };
import issueList from './__fixtures__/issueList.json' with { type: 'json' };
import mergeRequestVariants from './__fixtures__/mergeRequestVariants.json' with { type: 'json' };
import {
  buildGitlabEntryIdentity,
  isGitlabIdentityWithinOrigin,
  readGitlabProjectPath,
} from './identity.js';
import { normalizeGitlabConfiguredBaseUrl } from './origin.js';

function originOf(baseUrl: string) {
  const origin = normalizeGitlabConfiguredBaseUrl(baseUrl);
  if (!origin) throw new Error(`unusable base url: ${baseUrl}`);
  return origin;
}

const GITLAB_COM = originOf('https://gitlab.com');

function rowOf(value: unknown): Readonly<Record<string, unknown>> {
  return value as Readonly<Record<string, unknown>>;
}

describe('buildGitlabEntryIdentity', () => {
  it('keys a merge request on the project id and iid, never the instance-global id', () => {
    const result = buildGitlabEntryIdentity({
      kindId: 'merge-request',
      origin: GITLAB_COM,
      row: rowOf(mergeRequestList[0]),
    });
    if (result.kind !== 'built') throw new Error(result.reason);

    // project_id 3, iid 7, id 1 — the id must appear nowhere.
    expect(result.identity.entryId).toBe('7');
    expect(result.identity.collisionScope).toBe('gitlab:aHR0cHM6Ly9naXRsYWIuY29t:3');
    expect(result.identity.collisionScope).not.toContain(':1');
    expect(result.locator.repositoryKey).toBe('example-group/example-subgroup/example-project');
    expect(result.locator.displayPath).toBe('example-group/example-subgroup/example-project!7');
    expect(result.locator.routingToken).toBe(result.locator.repositoryKey);
  });

  it('keeps an issue and a merge request with the same project and IID distinct', () => {
    const mergeRequest = buildGitlabEntryIdentity({
      kindId: 'merge-request',
      origin: GITLAB_COM,
      row: rowOf(mergeRequestList[0]),
    });
    const issue = buildGitlabEntryIdentity({
      kindId: 'issue',
      origin: GITLAB_COM,
      row: rowOf(issueList[0]),
    });
    if (mergeRequest.kind !== 'built' || issue.kind !== 'built') throw new Error('expected both');

    expect(issue.identity.entryId).toBe(mergeRequest.identity.entryId);
    expect(issue.identity.collisionScope).toBe(mergeRequest.identity.collisionScope);
    // Only the kind separates them, and it is part of the identity.
    expect(issue.identity.kindId).not.toBe(mergeRequest.identity.kindId);
    expect(issue.locator.displayPath).toBe('example-group/example-subgroup/example-project#7');
  });

  it('keeps two configured origins in separate scopes without consulting the account', () => {
    const selfManaged = originOf('https://gitlab.example.com');
    const a = buildGitlabEntryIdentity({
      kindId: 'merge-request',
      origin: GITLAB_COM,
      row: rowOf(mergeRequestList[0]),
    });
    const b = buildGitlabEntryIdentity({
      kindId: 'merge-request',
      origin: selfManaged,
      row: rowOf(mergeRequestList[0]),
    });
    if (a.kind !== 'built' || b.kind !== 'built') throw new Error('expected both');
    expect(a.identity.collisionScope).not.toBe(b.identity.collisionScope);
    expect(isGitlabIdentityWithinOrigin(a.identity, GITLAB_COM)).toBe(true);
    expect(isGitlabIdentityWithinOrigin(a.identity, selfManaged)).toBe(false);
  });

  it('skips a row without an iid rather than falling back to the global id', () => {
    // `mergeRequestVariants.missingIid` carries `id: 8` and no `iid`. Falling back
    // to the global id would give one merge request a second identity and dedupe
    // would never converge.
    const result = buildGitlabEntryIdentity({
      kindId: 'merge-request',
      origin: GITLAB_COM,
      row: rowOf(mergeRequestVariants.missingIid),
    });
    expect(result).toEqual({ kind: 'undecodable', reason: 'missing-iid' });
  });
});

describe('readGitlabProjectPath', () => {
  it('reads nested groups from references.full, keeping every slash', () => {
    expect(readGitlabProjectPath('merge-request', rowOf(mergeRequestList[0])))
      .toBe('example-group/example-subgroup/example-project');
    // `references.relative` collapses to `!7` for a same-project row, so reading it
    // instead of `full` loses the path entirely — with no web_url to rescue it.
    expect(readGitlabProjectPath('merge-request', {
      references: { short: '!7', relative: '!7', full: 'example-group/team-a/app!7' },
    })).toBe('example-group/team-a/app');
  });

  it('falls back to web_url for both the /-/ and legacy path spellings', () => {
    expect(readGitlabProjectPath('issue', {
      web_url: 'https://gitlab.com/Example-Group/Team-A/App/-/issues/7',
    })).toBe('example-group/team-a/app');
    expect(readGitlabProjectPath('issue', {
      web_url: 'https://gitlab.com/example-group/team-a/app/issues/7',
    })).toBe('example-group/team-a/app');
  });

  it('never accepts _links.self as a locator, because it addresses the global id', () => {
    // GitLab's own published example returns `_links.self` pointing at
    // `/projects/{id}/issues/{globalId}` while `iid` is 7. Reading a route out of it
    // would address a different issue.
    expect(readGitlabProjectPath('issue', {
      _links: { self: 'https://gitlab.com/api/v4/projects/3/issues/76' },
    })).toBeNull();
  });
});
