import { expect, it } from 'vitest';
import { createPluginActionPresentUserGate, PluginActionContributionV2Schema } from '@happier-dev/protocol';
import { GITHUB_CI_ACTION_BINDINGS_V1 } from './contribution.js';
import { GITHUB_DEPLOYMENT_ACTIONS_V1 } from './deploymentReviews.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { GITHUB_CONNECTED_ACCOUNT_PURPOSE } from '../observations/githubProviderContracts.js';

it('binds only the schema-owned CI reads and review decisions to their exact credential operand', () => {
  const declarations = new Map((PLUGIN_MANIFEST.contributes.actions ?? []).map(action => [action.id, action]));
  for (const [id, binding] of Object.entries({ ...GITHUB_CI_ACTION_BINDINGS_V1, ...GITHUB_DEPLOYMENT_ACTIONS_V1 })) {
    const selectsCredential = id !== 'github/actions/deployment-review-target-read'
      && (binding.dangerLevel === 'safe' || id === 'github/actions/deployment-approve' || id === 'github/actions/deployment-reject');
    expect(declarations.get(id)?.connectedAccountPurposeBindings, id).toEqual(selectsCredential
      ? [{ path: 'credentialRef', purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE }]
      : undefined);
  }
});

it('admits safe native CI reads through the canonical read-only Resource bridge without granting it writes', () => {
  for (const binding of Object.values(GITHUB_CI_ACTION_BINDINGS_V1)) {
    if (binding.dangerLevel === 'safe') expect(binding).toMatchObject({ readOnly: true });
    else expect(binding).not.toHaveProperty('readOnly', true);
  }
});

it.each([
  ['github/actions/run-cancel', false], ['github/actions/run-rerun-all', false],
  ['github/actions/run-rerun-failed', false], ['github/actions/job-rerun', false],
  ['github/actions/workflow-dispatch', false], ['github/actions/workflow-enable', false], ['github/actions/workflow-disable', false],
  ['github/actions/job-log-download', false], ['github/actions/artifact-download', false],
  ['github/actions/run-force-cancel', true], ['github/actions/fork-run-approve', true],
] as const)('enforces the real person/agent/Ask policy for %s', async (id, confirms) => {
  const { run: _run, ...declaration } = GITHUB_CI_ACTION_BINDINGS_V1[id];
  const action = PluginActionContributionV2Schema.parse({ ...declaration, id, scopes: ['global'], execution: { target: 'daemon' } });
  const gate = (approvalRequiredByActionSettings?: boolean) => createPluginActionPresentUserGate({ resolve: () => ({
    status: 'resolved' as const, action, policy: {
      qualifiedId: `happier.scm-github/${id}`, occurrenceId: 'source', dangerLevel: action.dangerLevel, scopes: action.scopes, surfaces: action.surfaces,
      ...(action.confirmation === undefined ? {} : { confirmation: action.confirmation }),
      ...(action.confirmationWhen === undefined ? {} : { confirmationWhen: action.confirmationWhen }),
      ...(approvalRequiredByActionSettings === undefined ? {} : { approvalRequiredByActionSettings }),
      authorization: { generation: { targetGeneration: '1', desiredGeneration: '1', appliedGeneration: '1' }, resourceSelections: [], scopedGrants: [], serviceAvailability: [], operatingSystemAuthorization: [] },
    },
  }) });
  const refusal = { status: 'unavailable', code: 'plugin_action_current_intent_unavailable' };
  expect(await gate().admit({ surface: 'ui', invocationSurface: 'ui', invocationAuthority: 'present_user', input: {} }))
    .toMatchObject(confirms ? refusal : { status: 'admitted' });
  expect(await gate().admit({ surface: 'plugin', invocationSurface: 'ui', invocationAuthority: 'present_user', input: {} }))
    .toMatchObject(confirms ? refusal : { status: 'admitted' });
  for (const surface of ['agent', 'mcp'] as const) expect(await gate().admit({ surface, invocationSurface: surface, input: {} })).toMatchObject(refusal);
  // Reversible CLI edits default to Direct; an explicit saved Ask still requires intent.
  expect(await gate().admit({ surface: 'cli', invocationSurface: 'cli', input: {} }))
    .toMatchObject(action.dangerLevel === 'writesLocal' ? { status: 'admitted' } : refusal);
  expect(await gate(true).admit({ surface: 'cli', invocationSurface: 'cli', input: {} })).toMatchObject(refusal);
  expect(await gate().admit({ surface: 'plugin', invocationSurface: 'agent', invocationAuthority: 'account_automation', input: {} })).toMatchObject(refusal);
  expect(await gate(true).admit({ surface: 'ui', invocationSurface: 'ui', invocationAuthority: 'present_user', input: {} })).toMatchObject(refusal);
  expect(await gate(false).admit({ surface: 'agent', invocationSurface: 'agent', input: {} })).toMatchObject({ status: 'admitted' });
});
