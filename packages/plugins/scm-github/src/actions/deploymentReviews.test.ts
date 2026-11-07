import { describe, expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createPluginActionPresentUserGate, PluginActionContributionV2Schema } from '@happier-dev/protocol';
import { ForgeCiActionResultSchemasV1 } from '@happier-dev/triage-protocol/ci/v1';
import { GITHUB_DEPLOYMENT_ACTIONS_V1 } from './deploymentReviews.js';
import { createStubGithubTransport, readRecordedJsonBody } from '../triage/testkit/githubTriage.test-support.js';

const repository = { kind: 'github', deployment: 'https://github.com', repository: 'acme/widgets' } as const;
const pending = [{ environment: { id: 42, name: 'production' }, current_user_can_approve: true,
  wait_timer: 0, wait_timer_started_at: null, reviewers: [] }];
const run = { id: 81, run_attempt: 2, status: 'waiting', repository: { full_name: 'acme/widgets' } };

type ActionId = keyof typeof GITHUB_DEPLOYMENT_ACTIONS_V1;
type ActionSuffix = ActionId extends `github/actions/${infer Suffix}` ? Suffix : never;

async function invoke(action: ActionSuffix, input: JsonValue, respond: Parameters<typeof createStubGithubTransport>[0]['respond']) {
  const transport = createStubGithubTransport({ respond, nativeMaterialization: { kind: 'httpHeaders', headers: { Authorization: 'Bearer synthetic' } } });
  // Exercise the real declared binding, shared ingress and provider execution.
  // The separate test below retains the full-manifest activation boundary.
  return { result: await GITHUB_DEPLOYMENT_ACTIONS_V1[`github/actions/${action}`].run(input, transport.context), transport };
}

describe('GitHub deployment review Actions', () => {
  it('declares both decisions with automated approval and the shared form as person confirmation', async () => {
    const { PLUGIN_MANIFEST } = await import('../manifest.js');
    for (const id of ['deployment-approve', 'deployment-reject']) {
      const action = PLUGIN_MANIFEST.contributes.actions?.find(value => value.id === `github/actions/${id}`);
      expect(action).toMatchObject({ dangerLevel: 'writesRemote', surfaces: expect.arrayContaining(['ui', 'agent', 'mcp', 'cli']),
        confirmationWhen: { presentUserUi: false } });
      if (!action) throw new Error('Missing deployment Action declaration');
      const declared = PluginActionContributionV2Schema.parse(action);
      const gate = createPluginActionPresentUserGate({ resolve: () => ({ status: 'resolved' as const, action: declared,
        policy: { qualifiedId: `${PLUGIN_MANIFEST.id}/${declared.id}`, occurrenceId: 'test-occurrence',
          dangerLevel: declared.dangerLevel, scopes: declared.scopes, surfaces: declared.surfaces,
          confirmation: declared.confirmation, confirmationWhen: declared.confirmationWhen,
          authorization: { generation: { targetGeneration: '1', desiredGeneration: '1', appliedGeneration: '1' },
            resourceSelections: [], scopedGrants: [], serviceAvailability: [], operatingSystemAuthorization: [] } } }) });
      expect(await gate.admit({ surface: 'ui', invocationSurface: 'ui', invocationAuthority: 'present_user', input: {} })).toMatchObject({ status: 'admitted' });
      for (const surface of ['agent', 'mcp', 'cli'] as const) {
        expect(await gate.admit({ surface, invocationSurface: surface, input: {} })).toMatchObject({ status: 'unavailable', code: 'plugin_action_current_intent_unavailable' });
      }
    }
  });

  it('activates the deployment decisions through the complete plugin declaration', async () => {
    const { activate } = await import('../activate.js');
    const { PLUGIN_MANIFEST } = await import('../manifest.js');
    const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      for (const id of ['deployment-approve', 'deployment-reject']) {
        expect(typeof kit.registration('actions', `github/actions/${id}`)).toBe('function');
      }
    } finally { await kit.dispose(); }
  });

  it('reads pending environments conditionally without run, history, job or YAML fanout', async () => {
    const { result, transport } = await invoke('deployments-list', { repository, runId: '81', validator: 'prior' }, request => {
      expect(request.url).toBe('https://api.github.com/repos/acme/widgets/actions/runs/81/pending_deployments');
      expect(request.headers['If-None-Match']).toBe('prior');
      return { status: 200, headers: { etag: 'next' }, body: pending };
    });
    expect(ForgeCiActionResultSchemasV1.listDeployments.parse(result)).toMatchObject({ kind: 'value', validator: 'next',
      value: { rows: [{ id: '42', eligible: true, environment: { id: '42', name: 'production' } }], omittedRowCount: 0 } });
    expect(transport.requests).toHaveLength(1);
  });

  it('preserves a conditional pending response and reads review history only through its explicit Action', async () => {
    const unchanged = await invoke('deployments-list', { repository, runId: '81', validator: 'prior' }, () => ({ status: 304, headers: { etag: 'prior' } }));
    expect(unchanged.result).toEqual({ kind: 'notModified', validator: 'prior' });
    expect(unchanged.transport.requests).toHaveLength(1);
    const history = await invoke('deployment-history-read', { repository, runId: '81' }, request => {
      expect(request.url).toBe('https://api.github.com/repos/acme/widgets/actions/runs/81/approvals');
      return { status: 200, body: [{ environments: [{ id: 42, name: 'production' }], state: 'rejected', comment: 'Needs review.', user: { id: 7, login: 'reviewer' } }] };
    });
    expect(ForgeCiActionResultSchemasV1.readDeploymentHistory.parse(history.result)).toMatchObject({ kind: 'value',
      value: { rows: [{ environmentIds: ['42'], decision: 'rejected', comment: 'Needs review.', reviewer: 'reviewer' }], incomplete: null } });
    expect(history.transport.requests).toHaveLength(1);
  });

  it.each(['deployment-approve', 'deployment-reject'] as const)('sends only the explicitly selected environments and comment for %s', async action => {
    const { result, transport } = await invoke(action, { repository, runId: '81', attempt: '2', environmentIds: ['42'], comment: 'Reviewed this deployment.' }, request => {
      if (request.method === 'POST') return { status: 200, body: [] };
      return { status: 200, body: request.url.endsWith('/pending_deployments') ? pending : run };
    });
    expect(ForgeCiActionResultSchemasV1.approveDeployment.parse(result)).toMatchObject({ kind: 'accepted', affected: { environmentIds: ['42'] } });
    // GitHub returns deployments, not a review receipt with a native review id.
    expect(result).not.toHaveProperty('receipt');
    const writes = transport.requests.filter(request => request.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(readRecordedJsonBody(writes[0]!)).toEqual({ environment_ids: [42], state: action === 'deployment-approve' ? 'approved' : 'rejected', comment: 'Reviewed this deployment.' });
    expect(transport.requests).toHaveLength(3);
  });

  it.each([
    { attempt: '1', environmentIds: ['42'], eligible: true },
    { attempt: '2', environmentIds: ['99'], eligible: true },
    { attempt: '2', environmentIds: ['42'], eligible: false },
  ])('refuses stale or ineligible exact selection before any write: %j', async selection => {
    const { result, transport } = await invoke('deployment-approve', { repository, runId: '81', attempt: selection.attempt, environmentIds: selection.environmentIds, comment: '' },
      request => ({ status: 200, body: request.url.endsWith('/pending_deployments') ? [{ ...pending[0], current_user_can_approve: selection.eligible }] : run }));
    expect(result).toMatchObject({ kind: 'rejected' });
    expect(transport.requests.every(request => request.method === 'GET')).toBe(true);
  });

  it('keeps a lost response unknown and never repeats the review POST', async () => {
    let writes = 0;
    const { result } = await invoke('deployment-reject', { repository, runId: '81', attempt: '2', environmentIds: ['42'], comment: 'Needs a correction.' }, request => {
      if (request.method === 'POST') { writes++; throw new Error('lost response'); }
      return { status: 200, body: request.url.endsWith('/pending_deployments') ? pending : run };
    });
    expect(result).toMatchObject({ kind: 'outcome_unknown', affected: { environmentIds: ['42'] } });
    expect(writes).toBe(1);
  });
});
