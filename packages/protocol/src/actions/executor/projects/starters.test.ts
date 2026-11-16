import { ApprovalRequestSchema, type ApprovalRequest } from '../../../approvals/approvalRequestV1.js';
import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '../../actionExecutor.js';
import { getActionSpec } from '../../actionSpecs.js';
import { listHappierStarterCatalogV1, readHappierStarterCatalogItemV1, parseStarterCatalogV1 } from '../../../registries/formats/happierStarterCatalog.js';
import { ScmWorkingSnapshotSchema } from '../../../scm/workingSnapshot.js';
import { createScmCapabilities } from '../../../scm/capabilities.js';
import { ProjectStarterCreateOutputV1Schema } from '../../../projects/starters/createV1.js';
import { RegistryStarterV1Schema } from '../../../registries/registryStarterV1.js';
import { renderDeployPlanBriefV1 } from '../../../deployments/suggestions/deploySuggestionsV1.js';

const input = { serverId: 'home', machineId: 'machine', requestKey: 'starter-1', starterId: 'static-website',
  description: renderDeployPlanBriefV1('\nBuild a bakery website.\nKeep this first message unchanged.\n', {
    source: { kind: 'starter', starterId: 'static-website' }, targetId: 'own', whatToBuild: 'A bakery website',
    stack: { framework: 'html', output: 'static' }, data: { kind: 'none' }, variables: [],
  }), destinationParentPath: '/projects', destinationDirectoryName: 'bakery',
  repository: { owner: 'alice', name: 'bakery' } };
const starter = RegistryStarterV1Schema.parse({ repository: 'https://github.com/mdn/beginner-html-site-styled', title: 'Static website', description: 'A small HTML and CSS website starter.', tags: ['website'], buildGoal: 'Build a website.' });
const starterSelector = { provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
  repository: { nameWithOwner: 'mdn/beginner-html-site-styled', cloneUrl: starter.repository, webUrl: starter.repository }, protocol: 'https' };
const resolvedStarterAddress = { success: true, kind: 'resolved', selector: starterSelector };
const catalog = parseStarterCatalogV1({ schemaVersion: 1, starters: [{ itemId: 'static-website', starter }] });
const registryActionExecute = ({ actionId }: { actionId: string }) => Promise.resolve(actionId === 'registries.items.list'
  ? { pages: [listHappierStarterCatalogV1({ sourceId: 'builtin:starters', catalog, fetchedAt: 1 })] }
  : { item: readHappierStarterCatalogItemV1({ sourceId: 'builtin:starters', catalog, fetchedAt: 1, itemId: 'static-website' }) });
const snapshot = ScmWorkingSnapshotSchema.parse({
  projectKey: 'machine:/projects/bakery', fetchedAt: 1,
  repo: { isRepo: true, rootPath: '/projects/bakery', backendId: 'git', mode: '.git' },
  capabilities: createScmCapabilities(),
  branch: { head: 'main', headOid: '6c7a360ddb4a0d75be06044bf8a914f260ff10c7', upstream: null, ahead: 0, behind: 0, detached: false },
  hasConflicts: false, entries: [],
  totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
});

describe('starter creation public Action', () => {
  it.each([{ parent: '/projects', expected: '/projects/bakery' },
    { parent: '/projects/my\\folder', expected: '/projects/my\\folder/bakery' },
    { parent: '/projects/myfolder\\', expected: '/projects/myfolder\\/bakery' },
    { parent: 'C:\\Users\\alice\\src\\', expected: 'C:\\Users\\alice\\src\\bakery' },
    { parent: '\\\\server\\share\\src', expected: '\\\\server\\share\\src\\bakery' }])(
    'preserves destination path shape and refuses unavailable filesystem access at $parent', async ({ parent, expected }) => {
      const executor = createActionExecutor({
        scmActionExecute: async () => ({ success: true, auth: { state: 'authenticated', profileKind: 'connected_account' },
          defaultRepositoryName: 'bakery', targets: [] }),
        filesystemActionExecute: async ({ actionId, input: request }) => {
          expect(actionId).toBe('daemon.filesystem.browseDirectory');
          expect(request).toMatchObject({ path: expected });
          return { ok: false, errorCode: 'EACCES', error: 'Permission denied' };
        },
      });
      const { starterId: _starterId, ...base } = input;
      expect(await executor.execute('projects.starters.create', { ...base, source: { kind: 'scratch' }, destinationParentPath: parent },
        { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } }))
        .toMatchObject({ ok: true, result: { kind: 'failed', phase: 'checkout', code: 'EACCES' } });
    });
  it.each(['starter', 'scratch'] as const)('creates a %s source on the selected forge and hands off the accepted checkout', async kind => {
    const hostedRepository = { provider: { ...starterSelector.provider, id: 'happier.scm.forge.bitbucket/bitbucket', kind: 'bitbucket',
      displayName: 'Bitbucket', baseUrl: 'https://bitbucket.org' }, nameWithOwner: 'alice/bakery', visibility: 'private',
      webUrl: 'https://bitbucket.org/alice/bakery', cloneUrl: 'https://bitbucket.org/alice/bakery.git' };
    const effects: string[] = [];
    const executor = createActionExecutor({
      registryActionExecute,
      filesystemActionExecute: async ({ actionId }) => {
        effects.push(actionId);
        return actionId === 'daemon.filesystem.browseDirectory' ? { ok: false, error: 'Absent', errorCode: 'ENOENT' } : { success: true };
      },
      scmActionExecute: async ({ actionId, input: raw }) => {
        effects.push(actionId);
        const request = raw as { providerKind?: string; pushCurrentBranch?: boolean };
        if (actionId === 'scm.hostingRepository.resolveAddress') return resolvedStarterAddress;
        if (actionId === 'scm.hostingRepository.describePublishTargets') {
          expect(request.providerKind).toBe('bitbucket');
          return { success: true, auth: { state: 'authenticated', profileKind: 'connected_account' }, defaultRepositoryName: 'bakery', targets: [] };
        }
        if (actionId === 'scm.repository.init') return { success: true, alreadyInitialized: false,
          snapshot: { ...snapshot, branch: { ...snapshot.branch, headOid: undefined } } };
        if (actionId === 'scm.repository.clone') return { success: true, destinationPath: '/projects/bakery', cloneProtocol: 'https',
          cloneUrl: starter.repository, repository: { ...hostedRepository, provider: starterSelector.provider }, snapshot };
        expect(request.providerKind).toBe('bitbucket');
        expect(request.pushCurrentBranch).toBe(kind === 'starter');
        return { success: true, pushed: kind === 'starter', remote: { name: 'origin' }, repository: hostedRepository };
      },
      projectSourcesCreate: async value => ({ ok: true, canManage: true, source: { name: value.name,
        repository: value.repository, defaultRef: value.defaultRef, audience: value.audience, id: 'source', revision: 1,
        createdByAccountId: 'alice' } }),
      projectsOpen: async () => ({ kind: 'opened', workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'workspace',
        rootPath: '/projects/bakery' }, directory: '/projects/bakery', setup: 'notRequired', facts: { projectKey: 'project' } }),
    });
    const { starterId: _starterId, ...base } = input;
    const result = await executor.execute('projects.starters.create', { ...base,
      source: kind === 'starter' ? { kind, starterId: input.starterId } : { kind },
      repository: { ...input.repository, providerKind: 'bitbucket' } },
    { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'created', repositoryUrl: hostedRepository.webUrl,
      sessionHandoff: { directory: '/projects/bakery', initialMessage: input.description } } });
    if (kind === 'scratch') {
      expect(effects).not.toContain('scm.repository.clone');
      expect(result).not.toHaveProperty('result.commit');
      expect(result).not.toHaveProperty('result.starterId');
    } else expect(result).toMatchObject({ result: { starterId: input.starterId, commit: snapshot.branch.headOid } });
  });
  it('selects the exact registry source when catalog starters share an item id', async () => {
    const reads: string[] = [];
    let listedSources: unknown;
    const executor = createActionExecutor({
      registryActionExecute: async ({ actionId, input: request }) => {
        const value = request as { sourceIds?: string[]; sourceId?: string };
        if (actionId === 'registries.items.list') {
          listedSources = value.sourceIds;
          return { pages: ['first', 'chosen'].map(sourceId => listHappierStarterCatalogV1({ sourceId, catalog, fetchedAt: 1 })) };
        }
        reads.push(value.sourceId ?? '');
        return { item: readHappierStarterCatalogItemV1({ sourceId: value.sourceId!, catalog, fetchedAt: 1, itemId: 'static-website' }) };
      },
      scmActionExecute: async ({ actionId }) => actionId === 'scm.hostingRepository.resolveAddress'
        ? resolvedStarterAddress : { success: true, auth: { state: 'authentication_required', profileKind: 'no_auth' }, defaultRepositoryName: 'bakery', targets: [] },
    });
    const result = await executor.execute('projects.starters.create', { ...input, starterSourceId: 'chosen' },
      { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
    expect(result).toMatchObject({ ok: true, result: { kind: 'failed', code: 'scm_account_required' } });
    expect(listedSources).toEqual(['chosen']);
    expect(reads).toEqual(['chosen']);
  });
  it('admits the reviewed operands and defaults to a private repository', () => {
    const spec = getActionSpec('projects.starters.create');
    expect(spec.inputSchema.parse(input)).toMatchObject({ repository: { visibility: 'private' } });
    expect(spec.inputSchema.safeParse({ ...input, commit: 'moving-main' }).success).toBe(false);
    expect(spec.approvalPolicy?.uiConfirmation).toBe('direct');
  });
  it('refuses an unknown starter before any host effects', async () => {
    const result = await createActionExecutor({ registryActionExecute: () => Promise.resolve({ pages: [] }) }).execute('projects.starters.create', { ...input, starterId: 'missing' },
      { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'failed', code: 'starter_unavailable' } });
  });
});

// These ports cross into the target daemon and Home HTTP service. The Action
// normalization, admission, child execution and result projection remain real.
// Actual non-repository discovery and starter-to-clone composition are covered by
// CLI scmRpc.hostingRepositoryPublish.integration.test.ts using the real owner.
it.each([{ surface: 'ui', sourceFailure: false, publishFailure: false }, { surface: 'cli', sourceFailure: false, publishFailure: false },
  { surface: 'ui', sourceFailure: true, publishFailure: false }, { surface: 'ui', sourceFailure: false, publishFailure: true }] as const)(
  'preserves reviewed effects on $surface (Source refusal: $sourceFailure, publish refusal: $publishFailure)', async ({ surface, sourceFailure, publishFailure }) => {
  let request: ApprovalRequest | null = null;
  let approvals = 0;
  const calls: { actionId: string; input: unknown; context?: unknown }[] = [];
  // Publication returns its pre-push hosted summary. Default-branch metadata
  // may be absent; the SCM clone and push owners establish the current branch.
  const hostedRepository = { provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
    nameWithOwner: 'alice/bakery', visibility: 'private', webUrl: 'https://github.com/alice/bakery', cloneUrl: 'https://github.com/alice/bakery.git' };
  const executor = createActionExecutor({
    registryActionExecute,
    approvalsCreate: async ({ request: value }) => { approvals++; request = ApprovalRequestSchema.parse(value); return { artifactId: 'approval' }; },
    approvalsGet: async () => request,
    approvalsUpdate: async ({ request: value }) => { request = ApprovalRequestSchema.parse(value); return { ok: true }; },
    isApprovalExecutionOriginCurrent: async () => true,
    scmActionExecute: async args => {
      calls.push({ actionId: args.actionId, input: args.input, context: args.context });
      if (args.actionId === 'scm.hostingRepository.resolveAddress') return resolvedStarterAddress;
      if (args.actionId === 'scm.hostingRepository.describePublishTargets') return { success: true,
        auth: { state: 'authenticated', profileKind: 'connected_account' }, defaultRepositoryName: 'projects', targets: [] };
      if (args.actionId === 'scm.repository.clone') return { success: true, destinationPath: '/projects/bakery',
        cloneProtocol: 'https', cloneUrl: 'https://github.com/mdn/beginner-html-site-styled.git', repository: {
          provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
          nameWithOwner: 'mdn/beginner-html-site-styled', webUrl: 'https://github.com/mdn/beginner-html-site-styled', visibility: 'public' }, snapshot };
      return publishFailure ? { success: false, errorCode: 'COMMAND_FAILED', error: 'Push failed', repository: hostedRepository }
        : { success: true, pushed: true, remote: { name: 'origin' }, repository: hostedRepository };
    },
    projectSourcesCreate: async value => { calls.push({ actionId: 'projects.sources.create', input: value });
      return sourceFailure ? { ok: false, error: 'source_conflict' } : ({ ok: true, canManage: true, source: { name: value.name, repository: value.repository, defaultRef: value.defaultRef, id: 'source', revision: 1,
      audience: [], createdByAccountId: 'alice' } }); },
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
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'created', projectId: 'project', sourceId: 'source', commit: snapshot.branch.headOid,
      sessionHandoff: { initialMessage: input.description, directory: '/projects/bakery' } } });
    expect(approvals).toBe(0);
    // F6: one creation publishes one repository and one Source, then hands off;
    // validation and Production are later effects, never part of create.
    expect(calls.filter(call => call.actionId === 'scm.hostingRepository.publish')).toHaveLength(1);
    expect(calls.filter(call => call.actionId === 'projects.sources.create')).toHaveLength(1);
    expect(calls.filter(call => call.actionId === 'projects.open')).toHaveLength(2);
    expect(calls.some(call => call.actionId.startsWith('deployments.'))).toBe(false);
  }
  expect(calls.find(call => call.actionId === 'scm.repository.clone')?.input).toMatchObject({ ...starterSelector, initialCheckout: { branch: 'main', revision: 'latest-stable' } });
  expect(calls.find(call => call.actionId === 'scm.repository.clone')?.context).toMatchObject({
    externalActionTarget: { kind: 'machine', machineId: input.machineId } });
  expect(calls.find(call => call.actionId === 'scm.hostingRepository.publish')?.input).toMatchObject({
    owner: 'alice', repositoryName: 'bakery', visibility: 'private', pushCurrentBranch: true, remoteConflictStrategy: 'set-url' });
});

it('refuses disconnected SCM before workspace or repository mutation with the existing connect recovery', async () => {
  const executor = createActionExecutor({
    registryActionExecute,
    scmActionExecute: async ({ actionId }) => actionId === 'scm.hostingRepository.resolveAddress' ? resolvedStarterAddress : ({ success: true, auth: { state: 'authentication_required', profileKind: 'no_auth',
      remediation: { kind: 'auth_required', action: 'connect_github' } }, defaultRepositoryName: 'bakery', targets: [] }),
    projectsOpen: async () => { throw new Error('must not mutate a workspace'); },
  });
  expect(await executor.execute('projects.starters.create', input,
    { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } })).toMatchObject({ ok: true, result: {
      kind: 'failed', phase: 'account', code: 'scm_account_required', remediation: { action: 'connect_github' },
    } });
});


it('returns checkout_failed for an unparseable clone result before publication', async () => {
  const executor = createActionExecutor({
    registryActionExecute,
    scmActionExecute: async ({ actionId }) => {
      if (actionId === 'scm.hostingRepository.resolveAddress') return resolvedStarterAddress;
      if (actionId === 'scm.hostingRepository.describePublishTargets') return { success: true,
        auth: { state: 'authenticated', profileKind: 'connected_account' }, defaultRepositoryName: 'bakery', targets: [] };
      if (actionId === 'scm.repository.clone') return { success: true, destinationPath: '/projects/bakery' };
      throw new Error('must not publish an unvalidated checkout');
    },
  });
  expect(await executor.execute('projects.starters.create', input,
    { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } })).toMatchObject({ ok: true,
      result: { kind: 'failed', phase: 'checkout', code: 'checkout_failed' } });
});

it('passes the whole repository address to SCM and refuses an unrecognized subdirectory URL before effects', async () => {
  const address = starter.repository + '/tree/main/example';
  const unsupportedCatalog = parseStarterCatalogV1({ schemaVersion: 1, starters: [{ itemId: 'static-website', starter: { ...starter, repository: address } }] });
  const executor = createActionExecutor({
    registryActionExecute: async ({ actionId }) => actionId === 'registries.items.list'
      ? { pages: [listHappierStarterCatalogV1({ sourceId: 'builtin:starters', catalog: unsupportedCatalog, fetchedAt: 1 })] }
      : { item: readHappierStarterCatalogItemV1({ sourceId: 'builtin:starters', catalog: unsupportedCatalog, fetchedAt: 1, itemId: 'static-website' }) },
    scmActionExecute: async args => {
      expect(args.actionId).toBe('scm.hostingRepository.resolveAddress');
      expect(args.input).toEqual({ address });
      return { success: true, kind: 'unknown' };
    },
  });
  expect(await executor.execute('projects.starters.create', input,
    { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } })).toMatchObject({ ok: true,
      result: { kind: 'failed', phase: 'starter', code: 'starter_unavailable' } });
});


it.each(['source', 'project'] as const)('resumes the exact created repository and Source after %s refusal without repeating completed effects', async failingPhase => {
  const hostedRepository = { provider: starterSelector.provider, nameWithOwner: 'alice/bakery', visibility: 'private',
    webUrl: 'https://github.com/alice/bakery', cloneUrl: 'https://github.com/alice/bakery.git' };
  const source = { id: 'source-created-before-retry', revision: 1, name: 'bakery', repository: { provider: hostedRepository.provider,
    repository: { nameWithOwner: hostedRepository.nameWithOwner, webUrl: hostedRepository.webUrl, cloneUrl: hostedRepository.cloneUrl }, protocol: 'https' },
    defaultRef: 'main', audience: [], createdByAccountId: 'alice' };
  let shouldFail = true;
  const scmCalls: string[] = [];
  const sourceWrites: unknown[] = [];
  const sourceReads: unknown[] = [];
  const opened: unknown[] = [];
  const executor = createActionExecutor({
    registryActionExecute,
    scmActionExecute: async ({ actionId }) => {
      scmCalls.push(actionId);
      if (actionId === 'scm.hostingRepository.resolveAddress') return resolvedStarterAddress;
      if (actionId === 'scm.hostingRepository.describePublishTargets') return { success: true,
        auth: { state: 'authenticated', profileKind: 'connected_account' }, defaultRepositoryName: 'bakery', targets: [] };
      if (actionId === 'scm.repository.clone') return { success: true, destinationPath: '/projects/bakery', cloneProtocol: 'https',
        cloneUrl: starter.repository, repository: { ...hostedRepository, nameWithOwner: 'mdn/beginner-html-site-styled' }, snapshot };
      return { success: true, pushed: true, remote: { name: 'origin' }, repository: hostedRepository };
    },
    projectSourcesCreate: async value => { sourceWrites.push(value); return failingPhase === 'source' && shouldFail
      ? { ok: false, error: 'source_conflict' } : { ok: true, canManage: true, source }; },
    projectSourcesRead: async value => { sourceReads.push(value); return { ok: true, canManage: true, source }; },
    projectsOpen: async value => {
      opened.push(value);
      if (failingPhase === 'project' && shouldFail) return { kind: 'refused', code: 'workspace_unavailable' };
      return { kind: 'opened', workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'workspace', rootPath: '/projects/bakery' },
        directory: '/projects/bakery', setup: 'notRequired', facts: { projectKey: 'project' } };
    },
  });
  const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
  const first = await executor.execute('projects.starters.create', input, context);
  expect(first).toMatchObject({ ok: true, result: { kind: 'partial', phase: failingPhase, resume: {
    directory: '/projects/bakery', commit: snapshot.branch.headOid, repositoryUrl: hostedRepository.webUrl,
    repository: { repository: { nameWithOwner: 'alice/bakery' } },
    ...(failingPhase === 'project' ? { sourceId: source.id } : {}),
  } } });
  if (!first.ok) throw new Error('expected partial result');
  const partial = ProjectStarterCreateOutputV1Schema.parse(first.result);
  if (partial.kind !== 'partial') throw new Error('expected partial result');
  const effectsBeforeRetry = [...scmCalls];
  shouldFail = false;
  const retried = await executor.execute('projects.starters.create', { ...input, resume: partial.resume }, context);
  expect(retried).toMatchObject({ ok: true, result: { kind: 'created', projectId: 'project', sourceId: source.id,
    repositoryUrl: hostedRepository.webUrl, commit: snapshot.branch.headOid, sessionHandoff: { initialMessage: input.description } } });
  expect(scmCalls).toEqual(effectsBeforeRetry);
  expect(sourceWrites).toHaveLength(failingPhase === 'source' ? 2 : 1);
  expect(sourceReads).toEqual(failingPhase === 'project' ? [{ serverId: 'home', sourceId: source.id }] : []);
  expect(sourceWrites.at(-1)).toMatchObject({ requestKey: input.requestKey, repository: { repository: { nameWithOwner: 'alice/bakery' } } });
  expect(opened.at(-1)).toMatchObject({ source: { kind: 'source', id: source.id, selector: { repository: { nameWithOwner: 'alice/bakery' } } } });
});
