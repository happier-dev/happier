import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER } from '@happier-dev/protocol/actions';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createCliDeploymentActionDeps } from './createCliDeploymentActionDeps';
import { projectDeploymentFailure } from './deploymentFailure';
import { resolveDeploymentPreviewWorkflowSourceForHost } from './previewWorkflowSourceForHost';

afterEach(() => vi.restoreAllMocks());

it('preserves the template read refusal through preview workflow preparation', async () => {
  // HTTP is the boundary; Action execution, metadata transport and preview orchestration remain real.
  vi.spyOn(axios, 'request').mockResolvedValue({ status: 403, data: { error: 'invalid_token',
    authorizationRefusal: 'verification_purpose' } });
  const deps = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://preview.test',
    admitAccount: async () => null,
    resolveRequestHeaders: async () => ({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: 'fixture-proof' }),
    dispatchReceipt: async () => { throw new Error('Read cannot dispatch'); } });
  const { executor } = createCliActionExecutorHarness({ token: 'fixture', sessionId: '', mode: 'plain', ctx: null,
    serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'https://preview.test' },
  { ...createUnavailableActionTransportDeps(), ...deps });
  const repository = { kind: 'github' as const, deployment: 'https://github.com', repository: 'owner/app' };
  let caught: unknown;
  try {
    await resolveDeploymentPreviewWorkflowSourceForHost({ templateRef: { serverId: 'home', environmentId: 'template' },
      event: { id: '77', number: 12, action: 'opened', headSha: 'b'.repeat(40), headRef: 'feature', baseRef: 'main',
        baseRepository: repository, headRepository: repository, author: { id: 'person', login: 'person', kind: 'human' } },
      occurrenceKey: 'delivery', executor, credentials: { token: 'fixture', encryption: null },
      serverHttpBaseUrl: 'https://preview.test', contributes: createResolvedContributionRegistry({}) });
  } catch (error) { caught = error; }
  expect(axios.request).toHaveBeenCalledOnce();
  expect(projectDeploymentFailure('action_forbidden', caught)).toMatchObject({ ok: false, errorCode: 'action_forbidden',
    details: { requiredFact: 'verification_purpose' },
    failureCause: { phase: 'home.authorization.verification_purpose', httpStatus: 403 } });
});
