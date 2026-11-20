import { PLUGIN_MANIFEST, GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1 } from '../manifest.js';
import { pluginActionRequiresPresentUserIntent } from '@happier-dev/protocol';
import { TriageSourceDescriptorV1Schema, type TriageSourceScopeSelectionV1 } from '@happier-dev/triage-protocol/v1';
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
} from './configuration.js';

/** `PluginContributionLocalIdSchema`: lowercase segments joined by `-` or `/`. */
const CONTRIBUTION_LOCAL_ID_PATTERN = /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/u;

describe('GitHub Triage source declaration', () => {
  it('declares GitHub vocabulary that the published descriptor schema admits', () => {
    const parsed = TriageSourceDescriptorV1Schema.safeParse(GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1);

    expect(parsed.success).toBe(true);
    expect(GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1.purpose).toBe(GITHUB_CONNECTED_ACCOUNT_PURPOSE);
    const kindIds = GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1.kinds.map((kind) => kind.id);
    expect(kindIds).toEqual(['pull-request', 'issue', 'dependabot-alert', 'code-scanning-alert']);
    expect(new Set(kindIds).size).toBe(kindIds.length);
    for (const kindId of [...kindIds, GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1]) {
      expect(CONTRIBUTION_LOCAL_ID_PATTERN.test(kindId)).toBe(true);
    }
    // GitHub's workflow subjects are the source-neutral ones; only `pullRequest`
    // admits the optional review-workspace operation.
    expect(GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1.kinds.map((kind) => kind.workflowSubject))
      .toEqual(['pullRequest', 'issue', 'errorIssue', 'errorIssue']);
    expect(GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1.kinds[0]?.detailTabs?.find((tab) => tab.id === 'files'))
      .toMatchObject({ summaryFact: 'github/changed-files' });
    const issueCapabilities = GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1.kinds.find(kind => kind.id === 'issue')?.taskCapabilities;
    expect(issueCapabilities).not.toHaveProperty('completingTransitionId');
    expect(issueCapabilities?.transitions?.map(transition => transition.id)).toEqual(['open', 'completed', 'not_planned']);
    for (const kind of GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1.kinds.filter(kind => kind.workflowSubject === 'errorIssue')) {
      expect(kind.task).toBeUndefined();
      expect(kind.taskCapabilities).toBeUndefined();
    }
  });

  it('admits only its own declared kinds', () => {
    expect(readGithubTriageKindId('pull-request')).toBe('pull-request');
    expect(readGithubTriageKindId('issue')).toBe('issue');
    expect(readGithubTriageKindId('dependabot-alert')).toBe('dependabot-alert');
    expect(readGithubTriageKindId('code-scanning-alert')).toBe('code-scanning-alert');
    // Another forge's vocabulary is never flattened onto GitHub's.
    expect(readGithubTriageKindId('merge-request')).toBeNull();
    expect(readGithubTriageKindId('pullRequest')).toBeNull();
    expect(readGithubTriageKindId(undefined)).toBeNull();
  });
});

describe('GitHub Triage configured-instance token', () => {
  it('preserves opt-in families for All and selected scopes and rejects malformed switches', () => {
    const selections: TriageSourceScopeSelectionV1[] = [{ kind: 'all' }, { kind: 'selected', unitIds: ['org/app'] }];
    for (const selection of selections) {
      const configuration = { v: 1 as const, selection, alerts: { dependabot: true, codeScanning: false } };
      expect(decodeGithubTriageConfiguration(encodeGithubTriageConfiguration(configuration)))
        .toEqual({ ok: true, configuration });
    }
    expect(decodeGithubTriageConfiguration(JSON.stringify({ v: 1, selection: { kind: 'all' },
      alerts: { dependabot: 'yes', codeScanning: false } })).ok).toBe(false);
  });
  it('reads a non-empty repository set and rejects an empty set instead of silently scanning everything', () => {
    const selection = { kind: 'selected', unitIds: ['octo-org/app', 'octo-org/api'] };
    const decoded = decodeGithubTriageConfiguration(JSON.stringify({ v: 1, selection }));
    expect(decoded).toEqual({ ok: true, configuration: { v: 1, selection } });
    expect(decodeGithubTriageConfiguration(JSON.stringify({ v: 1, selection: { kind: 'selected', unitIds: [] } })).ok).toBe(false);
  });
  it('round-trips its own scopes and refuses anything it did not write', () => {
    const accountToken = encodeGithubTriageConfiguration({ v: 1, scope: { kind: 'account' } });
    const repositoryToken = encodeGithubTriageConfiguration({
      v: 1,
      scope: { kind: 'repository', repositoryKey: 'octo-org/example-app' },
    });
    if (accountToken === null || repositoryToken === null) throw new Error('tokens must encode');

    const account = decodeGithubTriageConfiguration(accountToken);
    const repository = decodeGithubTriageConfiguration(repositoryToken);
    expect(account.ok && account.configuration.selection).toEqual({ kind: 'all' });
    expect(repository.ok && repository.configuration.selection).toEqual({ kind: 'selected', unitIds: ['octo-org/example-app'] });
    expect(decodeGithubTriageConfiguration(JSON.stringify({ v: 1, scope: { kind: 'repository', repositoryKey: 'Octo-Org/Example-App' } })))
      .toEqual({ ok: true, configuration: { v: 1, selection: { kind: 'selected', unitIds: ['octo-org/example-app'] } } });

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

    expect(decoded.ok && decoded.configuration.selection).toEqual({ kind: 'selected', unitIds: ['octo-org/example-app'] });
  });
});

it.each([
  GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestClose,
  GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestReopen,
])('skips only the present person UI prompt for %s', id => {
  const action = PLUGIN_MANIFEST.contributes.actions.find(action => action.id === id);
  if (action === undefined) throw new Error(`Missing Action ${id}`);
  for (const surface of ['agent', 'mcp', 'cli', 'ui']) {
    expect(pluginActionRequiresPresentUserIntent(action, surface, undefined, 'account_automation')).toBe(true);
  }
  expect(pluginActionRequiresPresentUserIntent({ ...action, approvalRequiredByActionSettings: true }, 'ui', undefined, 'present_user')).toBe(true);
  expect(pluginActionRequiresPresentUserIntent(action, 'ui', undefined, 'present_user')).toBe(false);
});

it.each([
  GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestMerge,
  GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestSubmitReview,
])('retains the present person UI confirmation for %s', id => {
  const action = PLUGIN_MANIFEST.contributes.actions.find(action => action.id === id);
  if (action === undefined) throw new Error(`Missing Action ${id}`);
  expect(pluginActionRequiresPresentUserIntent(action, 'ui', undefined, 'present_user')).toBe(true);
});
