import { TriageSourceDescriptorV1Schema } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import { GITHUB_CONNECTED_ACCOUNT_PURPOSE } from '../observations/githubProviderContracts.js';

import {
  GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1,
  GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1,
  readGithubTriageKindId,
} from './contribution.js';
import {
  decodeGithubTriageConfiguration,
  encodeGithubTriageConfiguration,
  readGithubScanRepositoryKey,
} from './configuration.js';

/** `PluginContributionLocalIdSchema`: lowercase segments joined by `-` or `/`. */
const CONTRIBUTION_LOCAL_ID_PATTERN = /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/u;

describe('GitHub Triage source declaration', () => {
  it('declares GitHub vocabulary that the published descriptor schema admits', () => {
    const parsed = TriageSourceDescriptorV1Schema.safeParse(GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1);

    expect(parsed.success).toBe(true);
    expect(GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1.purpose).toBe(GITHUB_CONNECTED_ACCOUNT_PURPOSE);
    const kindIds = GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1.kinds.map((kind) => kind.id);
    expect(kindIds).toEqual(['pull-request', 'issue']);
    expect(new Set(kindIds).size).toBe(kindIds.length);
    for (const kindId of [...kindIds, GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1]) {
      expect(CONTRIBUTION_LOCAL_ID_PATTERN.test(kindId)).toBe(true);
    }
    // GitHub's workflow subjects are the source-neutral ones; only `pullRequest`
    // admits the optional review-workspace operation.
    expect(GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1.kinds.map((kind) => kind.workflowSubject))
      .toEqual(['pullRequest', 'issue']);
  });

  it('admits only its own declared kinds', () => {
    expect(readGithubTriageKindId('pull-request')).toBe('pull-request');
    expect(readGithubTriageKindId('issue')).toBe('issue');
    // Another forge's vocabulary is never flattened onto GitHub's.
    expect(readGithubTriageKindId('merge-request')).toBeNull();
    expect(readGithubTriageKindId('pullRequest')).toBeNull();
    expect(readGithubTriageKindId(undefined)).toBeNull();
  });
});

describe('GitHub Triage configured-instance token', () => {
  it('round-trips its own scopes and refuses anything it did not write', () => {
    const accountToken = encodeGithubTriageConfiguration({ v: 1, scope: { kind: 'account' } });
    const repositoryToken = encodeGithubTriageConfiguration({
      v: 1,
      scope: { kind: 'repository', repositoryKey: 'octo-org/example-app' },
    });
    if (accountToken === null || repositoryToken === null) throw new Error('tokens must encode');

    const account = decodeGithubTriageConfiguration(accountToken);
    const repository = decodeGithubTriageConfiguration(repositoryToken);
    expect(account.ok && readGithubScanRepositoryKey(account.configuration)).toBeNull();
    expect(repository.ok && readGithubScanRepositoryKey(repository.configuration))
      .toBe('octo-org/example-app');

    // A foreign, malformed, versionless or path-escaping token is an explicit
    // unsupported-contract failure, never a guessed scope.
    for (const token of [
      '',
      'not-json',
      JSON.stringify({ v: 2, scope: { kind: 'account' } }),
      JSON.stringify({ v: 1, scope: { kind: 'organization', login: 'octo-org' } }),
      JSON.stringify({ v: 1, scope: { kind: 'repository', repositoryKey: '../../etc/passwd' } }),
      JSON.stringify({ v: 1, scope: { kind: 'repository', repositoryKey: 'octo-org' } }),
      JSON.stringify({ v: 1, scope: { kind: 'repository', repositoryKey: 'https://api.github.com/x/y' } }),
    ]) {
      const decoded = decodeGithubTriageConfiguration(token);
      expect(decoded.ok).toBe(false);
      if (decoded.ok) throw new Error('unreachable');
      expect(decoded.failure).toEqual({
        class: 'unsupportedContract',
        code: 'github_configuration_invalid',
      });
    }
  });

  it('lowercases the repository key it decodes so one instance has one lane scope', () => {
    const token = encodeGithubTriageConfiguration({
      v: 1,
      scope: { kind: 'repository', repositoryKey: 'Octo-Org/Example-App' },
    });
    if (token === null) throw new Error('the token must encode');

    const decoded = decodeGithubTriageConfiguration(token);

    expect(decoded.ok && readGithubScanRepositoryKey(decoded.configuration))
      .toBe('octo-org/example-app');
  });
});
