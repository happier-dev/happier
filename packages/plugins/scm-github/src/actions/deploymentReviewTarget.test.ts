import { describe, expect, it } from 'vitest';
import { createStubGithubTransport } from '../triage/testkit/githubTriage.test-support.js';
import { GITHUB_DEPLOYMENT_ACTIONS_V1 } from './deploymentReviews.js';

const actionId = 'github/actions/deployment-review-target-read';
function targetAction() {
  const action = Object.entries(GITHUB_DEPLOYMENT_ACTIONS_V1).find(([id]) => id === actionId)?.[1];
  expect(action, 'the deployment Action family exposes the locator read').toBeDefined();
  if (!action) throw new Error('Deployment review target Action is not declared');
  return action;
}

const location = 'repositories/77/runs/81/attempts/2/environments/42';
const repository = { kind: 'github', deployment: 'https://github.com', repository: 'acme/widgets' } as const;
const nativeRepository = { id: 77, full_name: 'acme/widgets', name: 'widgets', owner: { login: 'acme' } };

async function invoke(body: unknown, status = 200) {
  const transport = createStubGithubTransport({
    nativeMaterialization: { kind: 'httpHeaders', headers: { Authorization: 'Bearer test-only-placeholder' } },
    respond: () => ({ status, body }),
  });
  const result = await targetAction().run({ location }, transport.context);
  return { result, transport };
}

describe('deployment review locator admission', () => {
  it('resolves immutable repository identity without a Project, source catalog, CI reads or credential selection', async () => {
    const { result, transport } = await invoke(nativeRepository);
    expect(result).toEqual({ kind: 'ready', repository,
      location: { repositoryId: '77', runId: '81', attempt: '2', environmentId: '42' } });
    expect(transport.requests.map(request => request.url)).toEqual(['https://api.github.com/repositories/77']);
    expect(transport.listRequests).toEqual([]);
  });

  it.each([{ ...nativeRepository, id: 88 }, { ...nativeRepository, full_name: 'other/widgets' }])(
    'refuses mismatched immutable provenance: %j', async body => {
      const { result } = await invoke(body);
      expect(result).toMatchObject({ kind: 'unavailable', failure: { class: 'unsupportedContract' } });
    });

  it('preserves authentication failure instead of returning another account or monitoring source', async () => {
    const { result, transport } = await invoke({}, 401);
    expect(result).toEqual({ kind: 'unavailable', failure: { class: 'authentication', code: 'github_unauthorized' } });
    expect(transport.requests).toHaveLength(1);
  });

  it('rejects malformed or cancelled locators before provider IO', async () => {
    const controller = new AbortController();
    const transport = createStubGithubTransport({ signal: controller.signal, respond: () => undefined });
    const action = targetAction();
    expect(await action.run({ location: '../repositories/77' }, transport.context)).toMatchObject({ kind: 'unavailable' });
    controller.abort();
    await expect(action.run({ location }, transport.context)).rejects.toThrow();
    expect(transport.requests).toEqual([]);
  });
});
