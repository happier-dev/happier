import { describeApprovalRequestFields, projectTargetActionApprovalInput } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/public-types';
import type { TargetActionApprovalRequestV1 } from '@happier-dev/protocol';
import { expect, it, vi } from 'vitest';
import { SESSION_PULL_REQUEST_BINDING_ACTION_ID_V1, SessionPullRequestBindingInputV1Schema } from '@happier-dev/channels-protocol/v1';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { PLUGIN_MANIFEST as CHANNELS_MANIFEST } from '../../../../../../packages/plugins/channels/src/manifest';
import { GITHUB_TRIAGE_ACTION_IDS_V1, PLUGIN_MANIFEST } from '../../../../../../packages/plugins/scm-github/src/manifest';
import { createTargetActionCurrentIntentAdapter } from './targetActionCurrentIntent';

const action = PLUGIN_MANIFEST.contributes.actions.find(({ id }) => id === GITHUB_TRIAGE_ACTION_IDS_V1.create)!;
const token = 'fake-private-source-configuration';
const fields = { scopeId: 'github:1424792902', title: 'QB-50 sandbox issue', body: 'Projection regression' };
const input = { v: 1, instance: { configuration: { v: 1, token }, locator: { displayLabel: 'Sandbox GitHub' } }, kindId: 'issue', fields };
const expected = [
  ['Repository', fields.scopeId],
  ['Connected Account', 'Sandbox GitHub'],
  ['Title', fields.title],
  ['Description', fields.body],
];

function visibleFacts(presentation: ReturnType<typeof describeApprovalRequestFields>) {
  return presentation.rows.flatMap(row => row.kind === 'value' && !row.technical && row.valueFormat !== 'confidential'
    ? [[row.title, row.value]] : []);
}

it.each([
  ['prComment', 'Pull request comment'],
  ['ciFailed', 'CI check failed'],
] as const)('shows a Channels attach approval with the label for %s', async (triggerKind, triggerLabel) => {
  const binding = CHANNELS_MANIFEST.contributes?.actions?.find(({ id }) => id === SESSION_PULL_REQUEST_BINDING_ACTION_ID_V1);
  if (!binding) throw new Error('Expected the Channels PR binding Action');
  const parsed = parsePluginManifest({
    ...CHANNELS_MANIFEST,
    contributes: { ...CHANNELS_MANIFEST.contributes, actions: [binding] },
  });
  if (!parsed.ok) throw new Error(parsed.diagnostics.map(({ message }) => message).join('\n'));
  const action = parsed.manifest.contributes.actions?.[0];
  if (!action) throw new Error('Expected the normalized PR binding Action');

  const artifactId = 'channels-pr-attach-approval';
  const create = vi.fn(async (request: TargetActionApprovalRequestV1) => {
    setImmediate(() => { void getSharedBlockingApprovalCoordinator().resolveBlockingDecision({
      artifactId, request: { ...request, status: 'rejected', decision: { kind: 'reject', decidedAtMs: 2 } },
      decision: 'reject', decisionAuthority: 'present_user',
    }); });
    return { artifactId };
  });
  const adapter = createTargetActionCurrentIntentAdapter({ create, read: async () => null, update: async () => ({ ok: true }) });
  await expect(adapter({
    action: {
      qualifiedId: `${parsed.manifest.id}/actions/${action.id}`,
      pluginId: parsed.manifest.id, localId: action.id, occurrenceId: '7',
      sourceCustody: { kind: 'development', registeredRootId: 'root-7' },
      dangerLevel: action.dangerLevel, scopes: action.scopes, surfaces: action.surfaces, hostAccess: [],
      input: SessionPullRequestBindingInputV1Schema.parse({
        kind: 'attach', sessionId: 'session-1',
        pullRequest: { repository: 'example/project', number: 4 },
        target: { automationId: 'automation-1', triggerId: 'trigger-1', triggerRevision: 0, triggerKind },
      }),
      policyFingerprint: 'b'.repeat(64), confirmation: action.confirmation && {
        ...action.confirmation,
        variant: {
          when: { op: 'eq', path: 'target.triggerKind', value: 'ciFailed' },
          title: 'Attach the pull request to failed CI?',
          body: 'The selected Workflow will receive failed CI events.',
          inputFields: action.confirmation.inputFields,
        },
      },
    },
    fingerprint: 'a'.repeat(64), surface: 'agent', approvalInputCustody: 'live_only',
  })).resolves.toMatchObject({ status: 'rejected' });

  const request = create.mock.calls[0]![0];
  const facts = visibleFacts(describeApprovalRequestFields(request));
  expect(facts).toEqual(expect.arrayContaining([
    ['Repository', 'example/project'],
    ['Pull request number', '4'],
    ['Workflow trigger', triggerLabel],
  ]));
  expect(request.input).toMatchObject({ target: { triggerKind } });
  expect(facts.flat()).not.toContain('Target');
  expect(facts.flat()).not.toContain('Pull request');
  if (triggerKind === 'ciFailed') {
    expect(request.summary).toBe('Attach the pull request to failed CI?');
    expect(request.detail).toBe('The selected Workflow will receive failed CI events.');
  } else {
    expect(request.summary).toBe('Change this session’s pull request binding?');
  }
});

it('action.invoke exposes declared issue-create facts without the configuration token', () => {
  const projected = projectTargetActionApprovalInput(input, ['instance.configuration.token'])!;
  const presentation = describeApprovalRequestFields({
    actionId: 'action.invoke',
    actionArgs: { action: { pluginId: PLUGIN_MANIFEST.id, localId: action.id }, input: projected.input },
    preview: { contributedAction: { title: 'Create this issue?', fields: action.confirmation!.inputFields!.map(({ path, title }) => ({
      path, title: resolvePluginLocalizedStringV2Text(title),
    })) } },
  });
  expect(JSON.stringify(presentation)).not.toContain(token);
  expect(visibleFacts(presentation)).toEqual(expected);
});

it.each([false, true])('plugin_target_action exposes only declared facts, configuration marked secret: %s', async configurationSecret => {
  const artifactId = `issue-create-approval-presentation-${configurationSecret}`;
  const fakeCarrierValue = 'fake-secret-carrier-value';
  const create = vi.fn(async (request: TargetActionApprovalRequestV1) => {
    setImmediate(() => { void getSharedBlockingApprovalCoordinator().resolveBlockingDecision({ artifactId,
      request: { ...request, status: 'rejected', decision: { kind: 'reject', decidedAtMs: 2 } },
      decision: 'reject', decisionAuthority: 'present_user',
    }); });
    return { artifactId };
  });
  const adapter = createTargetActionCurrentIntentAdapter({ create, read: async () => null, update: async () => ({ ok: true }) });
  await expect(adapter({
    action: {
      qualifiedId: `${PLUGIN_MANIFEST.id}/actions/${action.id}`, pluginId: PLUGIN_MANIFEST.id, localId: action.id, occurrenceId: '7',
      sourceCustody: { kind: 'development', registeredRootId: 'root-7' },
      dangerLevel: 'writesRemote', scopes: ['global'], surfaces: ['agent'], hostAccess: [],
      input: { ...input, carrier: { _isSecretValue: true, value: fakeCarrierValue } },
      secretInputPaths: configurationSecret ? ['instance.configuration.token'] : [], policyFingerprint: 'b'.repeat(64),
      confirmation: { ...action.confirmation!, inputFields: [
        ...action.confirmation!.inputFields!,
        ...(configurationSecret ? [{ path: 'instance.configuration.token', title: 'Declared secret' }] : []),
        { path: 'carrier', title: 'Secret carrier' },
      ] },
    },
    fingerprint: 'a'.repeat(64), surface: 'agent', approvalInputCustody: 'live_only',
  })).resolves.toMatchObject({ status: 'rejected' });
  const request = create.mock.calls[0]![0];
  const presentation = describeApprovalRequestFields(request);
  expect(JSON.stringify(request).includes(token)).toBe(!configurationSecret);
  expect(JSON.stringify(request)).not.toContain(fakeCarrierValue);
  expect(visibleFacts(presentation)).toEqual(expected);
  const technical = presentation.rows.filter(row => row.kind === 'value' && row.technical);
  expect(technical).toContainEqual(expect.objectContaining({ path: 'input.instance' }));
  expect(JSON.stringify(technical).includes(token)).toBe(!configurationSecret);
  expect(JSON.stringify(presentation)).not.toContain(fakeCarrierValue);
  if (configurationSecret) expect(JSON.stringify(presentation)).not.toContain(token);
});
