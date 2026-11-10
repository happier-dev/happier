import { ApprovalRequestSchema, type ApprovalRequest } from '../../../approvals/approvalRequestV1.js';
import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '../../actionExecutor.js';
import { getActionSpec } from '../../actionSpecs.js';

const input = { serverId: 'home', machineId: 'machine', requestKey: 'starter-1', starterId: 'static-website',
  description: '\nBuild a bakery website.\nKeep this first message unchanged.\n', destinationParentPath: '/projects', destinationDirectoryName: 'bakery',
  repository: { owner: 'alice', name: 'bakery' } };

describe('starter creation public Action', () => {
  it('admits the reviewed operands and defaults to a private repository', () => {
    const spec = getActionSpec('projects.starters.create');
    expect(spec.inputSchema.parse(input)).toMatchObject({ repository: { visibility: 'private' } });
    expect(spec.inputSchema.safeParse({ ...input, commit: 'moving-main' }).success).toBe(false);
    expect(spec.approvalPolicy?.uiConfirmation).toBe('direct');
  });
  it('refuses an unknown starter before any host effects', async () => {
    const result = await createActionExecutor({}).execute('projects.starters.create', { ...input, starterId: 'missing' },
      { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'failed', code: 'starter_unavailable' } });
  });
});

// These ports cross into the target daemon and Home HTTP service. The Action
// normalization, admission, child execution and result projection remain real.
it.each([{ surface: 'ui', sourceFailure: false, publishFailure: false }, { surface: 'cli', sourceFailure: false, publishFailure: false },
  { surface: 'ui', sourceFailure: true, publishFailure: false }, { surface: 'ui', sourceFailure: false, publishFailure: true }] as const)(
  'preserves reviewed effects on $surface (Source refusal: $sourceFailure, publish refusal: $publishFailure)', async ({ surface, sourceFailure, publishFailure }) => {
  let request: ApprovalRequest | null = null;
  let approvals = 0;
  const calls: { actionId: string; input: unknown; context?: unknown }[] = [];
  // Publication returns its pre-push hosted summary. Default-branch metadata
  // may be absent; the SCM clone and push owners establish main at the pin.
  const hostedRepository = { provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
    nameWithOwner: 'alice/bakery', visibility: 'private', webUrl: 'https://github.com/alice/bakery', cloneUrl: 'https://github.com/alice/bakery.git' };
  const executor = createActionExecutor({
    approvalsCreate: async ({ request: value }) => { approvals++; request = ApprovalRequestSchema.parse(value); return { artifactId: 'approval' }; },
    approvalsGet: async () => request,
    approvalsUpdate: async ({ request: value }) => { request = ApprovalRequestSchema.parse(value); return { ok: true }; },
    isApprovalExecutionOriginCurrent: async () => true,
    scmActionExecute: async args => {
      calls.push({ actionId: args.actionId, input: args.input, context: args.context });
      if (args.actionId === 'scm.hostingRepository.describePublishTargets') return { success: true,
        auth: { state: 'authenticated', profileKind: 'connected_account' }, defaultRepositoryName: 'bakery', targets: [] };
      if (args.actionId === 'scm.repository.clone') return { success: true, destinationPath: '/projects/bakery',
        cloneProtocol: 'https', cloneUrl: 'https://github.com/mdn/beginner-html-site-styled.git', repository: {
          provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
          nameWithOwner: 'mdn/beginner-html-site-styled', webUrl: 'https://github.com/mdn/beginner-html-site-styled', visibility: 'public' } };
      return publishFailure ? { success: false, errorCode: 'COMMAND_FAILED', error: 'Push failed', repository: hostedRepository }
        : { success: true, pushed: true, remote: { name: 'origin' }, repository: hostedRepository };
    },
    projectSourcesCreate: async value => sourceFailure ? { ok: false, error: 'source_conflict' } : ({ ok: true, canManage: true, source: { name: value.name, repository: value.repository, defaultRef: value.defaultRef, id: 'source', revision: 1,
      audience: [], createdByAccountId: 'alice' } }),
    projectsOpen: async value => { calls.push({ actionId: 'projects.open', input: value }); return ({ kind: 'opened', workspace: { serverId: 'home', machineId: 'machine',
      workspaceId: 'workspace', rootPath: '/projects/bakery' }, directory: '/projects/bakery', setup: 'notRequired', facts: { projectKey: 'project' } }); },
  });
  const context = { surface, authority: 'present_user', actionCaller: { kind: 'host' },
    serverId: 'home', runtimeAccountId: 'alice', actionRequestId: 'starter-1' } as const;
  const result = await executor.execute('projects.starters.create', input, context);
  if (surface === 'cli') {
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(calls).toEqual([]);
    const decision = await executor.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' }, context);
    expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true });
    expect(request).toMatchObject({ status: 'executed' });
    expect(approvals).toBe(1);
  } else if (publishFailure) {
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'partial', phase: 'publish',
      code: 'COMMAND_FAILED', repositoryUrl: 'https://github.com/alice/bakery', directory: '/projects/bakery' } });
    expect(calls.filter(call => call.actionId === 'projects.open')).toHaveLength(0);
  } else if (sourceFailure) {
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'partial', phase: 'source',
      code: 'source_conflict', repositoryUrl: 'https://github.com/alice/bakery', directory: '/projects/bakery' } });
    expect(calls.filter(call => call.actionId === 'scm.hostingRepository.publish')).toHaveLength(1);
    expect(calls.filter(call => call.actionId === 'projects.open')).toHaveLength(0);
  } else {
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'created', projectId: 'project', sourceId: 'source',
      sessionHandoff: { initialMessage: input.description, directory: '/projects/bakery' } } });
    expect(approvals).toBe(0);
  }
  expect(calls.find(call => call.actionId === 'scm.repository.clone')?.input).toMatchObject({
    initialCheckout: { branch: 'main', commit: '6c7a360ddb4a0d75be06044bf8a914f260ff10c7' } });
  expect(calls.find(call => call.actionId === 'scm.repository.clone')?.context).toMatchObject({
    externalActionTarget: { kind: 'machine', machineId: input.machineId } });
  expect(calls.find(call => call.actionId === 'scm.hostingRepository.publish')?.input).toMatchObject({
    owner: 'alice', repositoryName: 'bakery', visibility: 'private', pushCurrentBranch: true, remoteConflictStrategy: 'set-url' });
});

it('refuses disconnected SCM before workspace or repository mutation with the existing connect recovery', async () => {
  const executor = createActionExecutor({
    scmActionExecute: async () => ({ success: true, auth: { state: 'authentication_required', profileKind: 'no_auth',
      remediation: { kind: 'auth_required', action: 'connect_github' } }, defaultRepositoryName: 'bakery', targets: [] }),
    projectsOpen: async () => { throw new Error('must not mutate a workspace'); },
  });
  expect(await executor.execute('projects.starters.create', input,
    { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } })).toMatchObject({ ok: true, result: {
      kind: 'failed', phase: 'account', code: 'scm_account_required', remediation: { action: 'connect_github' },
    } });
});
