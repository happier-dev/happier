import { ProjectSourcesUpdateInputV1Schema, type ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryCatalogKeyV1Schema, PromptLibraryRowMutationV1Schema,
  type PromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createPlainArtifactHomeFixture } from './artifactStoreBoundary';
import { createSessionFixture, createPlainSessionByIdResponseFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionReadBatchFetchBoundary } from './sessionReadBatchHttpBoundary';

export async function createMemoryDecisionHomeFixture(options: Readonly<{
  sessionProject?: boolean;
  handleRequest?: (path: string, init?: RequestInit) => Promise<Response | null>;
}> = {}) {
  let serverId = '';
  let sessionProjectAccess: 'writable' | 'readonly' | 'unavailable' = 'writable';
  const session = createSessionFixture({ id: 'source-session', metadata: { path: '/work/payments', host: 'qa', machineId: 'offline',
    workspaceId: 'core-payments', projectId: 'core-payments' } }, { memoryEnabled: true });
  // The Home serves the same Session facts through single and batched snapshot transport.
  const sessionReads = createSessionReadBatchFetchBoundary(async input => new URL(String(input)).pathname === '/v2/sessions/source-session'
    ? Response.json(createPlainSessionByIdResponseFixture(session)) : null);
  let failAttachment = true;
  let projectCatalogUnavailable = false;
  let unknownSourceResolved = false;
  let decisionRefusal: 'memory_decision_disclosure_denied' | 'memory_decision_source_unavailable' | null = null;
  let coding: Extract<PromptLibraryRecordV1, { key: 'coding' }> = { key: 'coding', value: { v: 1, scope: { kind: 'coding' }, entries: [] } };
  let codingRevision = 1;
  let source: ProjectSourceV1 = { id: 'qa-writable', revision: 1, name: 'QA Payments', createdByAccountId: 'artifact-account', audience: [], attachments: [],
    repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
      repository: { nameWithOwner: 'qa/payments', visibility: 'private' }, protocol: 'https' } };
  let sessionSource: ProjectSourceV1 = { ...source, id: 'qa-session', name: 'Core payments', attachments: [] };
  const home = await createPlainArtifactHomeFixture('https://decision-targets.test', { currentAccount: true,
    admitMemoryDecisionSource: ref => ref.messageId === 'committed-source'
      && (ref.kind === 'session' ? ref.session.serverId : ref.discussion.serverId) === serverId,
    handleRequest: async (path, init) => {
    if (options.handleRequest) {
      const response = await options.handleRequest(path, init);
      if (response) return response;
    }
    if (path.includes('/memory-decision') && decisionRefusal) return Response.json({ error: decisionRefusal },
      { status: decisionRefusal === 'memory_decision_disclosure_denied' ? 403 : 404 });
    if (path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: {
      actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'memory.decision.save': ['ui'], 'memory.remember': ['ui'], 'projects.sources.update': ['ui'] } },
    } } });
    if (path === PROJECT_ACCOUNT_ROWS_ROUTE_V1 + '/list' && projectCatalogUnavailable) return Response.json({ error: 'offline' }, { status: 503 });
    if (path === PROJECT_ACCOUNT_ROWS_ROUTE_V1 + '/list') return Response.json(createPlainProjectAccountRowListFixture({ workspaceRefs: [
      { id: 'payments', serverId, projectKey: 'payments', machineId: 'offline', rootPath: '/qa/payments', createdAtMs: 1,
        source: { sourceId: source.id, revision: 1 } },
      { id: 'readonly', serverId, projectKey: 'readonly', machineId: 'offline', rootPath: '/qa/readonly', createdAtMs: 1,
        source: { sourceId: 'qa-readonly', revision: 1 } },
      { id: 'unknown', serverId, projectKey: 'unknown', machineId: 'offline', rootPath: '/qa/unknown', createdAtMs: 1,
        source: { sourceId: 'qa-unknown', revision: 1 } },
      ...(options.sessionProject ? [{ id: 'core-payments', serverId, projectKey: 'core-payments', machineId: 'offline', rootPath: '/work/payments', createdAtMs: 1,
        source: { sourceId: 'qa-session', revision: 1 } }] : []),
    ], organizations: options.sessionProject ? [
      { key: { kind: 'project-organization', serverId, projectKey: 'core-payments' }, revision: 1, value: { label: 'Core payments' } },
      { key: { kind: 'project-organization', serverId, projectKey: 'payments' }, revision: 1, value: { label: 'payments' } },
    ] : [] }));
    if (path === '/v2/sessions/source-session' || path === '/v2/sessions/read-batch') {
      return sessionReads(`https://decision-targets.test${path}`, init);
    }
    if (path.startsWith('/v1/projects/sources/qa-session')) {
      if (sessionProjectAccess === 'unavailable') return Response.json({ error: 'offline' }, { status: 503 });
      if (init?.method === 'PATCH') {
        const input = ProjectSourcesUpdateInputV1Schema.parse(JSON.parse(String(init.body)));
        if (input.patch.attachment?.kind !== 'attach') throw new Error('Expected context attachment');
        sessionSource = { ...sessionSource, revision: sessionSource.revision + 1,
          attachments: [...(sessionSource.attachments ?? []), input.patch.attachment.attachment] };
      }
      return Response.json({ ok: true, source: sessionSource, canManage: sessionProjectAccess === 'writable' });
    }
    if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return Response.json({ status: 'listed', rows: [
      { key: 'coding', revision: codingRevision, content: { t: 'plain', v: coding } },
      ...PromptLibraryCatalogKeyV1Schema.options.filter(key => key !== 'coding').map(key => ({ key, revision: 1, content: null })),
    ] });
    if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1 + '/coding' && init?.method === 'POST') {
      const mutation = PromptLibraryRowMutationV1Schema.parse(JSON.parse(String(init.body)));
      if (mutation.expectedRevision !== codingRevision) return Response.json({ status: 'conflict', revision: codingRevision }, { status: 409 });
      if (mutation.content?.t !== 'plain' || mutation.content.v.key !== 'coding') throw new Error('Expected canonical coding record');
      coding = mutation.content.v;
      codingRevision++;
      return Response.json({ status: 'updated', revision: codingRevision, cursor: codingRevision });
    }
    if (path.startsWith('/v1/projects/sources/qa-writable')) {
      if (init?.method === 'PATCH') {
        if (failAttachment) return Response.json({ error: 'database_transaction_conflict_exhausted' }, { status: 503 });
        const input = ProjectSourcesUpdateInputV1Schema.parse(JSON.parse(String(init.body)));
        if (input.patch.attachment?.kind !== 'attach') throw new Error('Expected existing attachment writer');
        source = { ...source, revision: source.revision + 1, attachments: [...(source.attachments ?? []), input.patch.attachment.attachment] };
      }
      return Response.json({ ok: true, source, canManage: true });
    }
    if (path.startsWith('/v1/projects/sources/qa-readonly')) return Response.json({ ok: true, source: { ...source, id: 'qa-readonly' }, canManage: false });
    if (path.startsWith('/v1/projects/sources/qa-unknown')) return unknownSourceResolved
      ? Response.json({ ok: true, source: { ...source, id: 'qa-unknown' }, canManage: false })
      : Response.json({ error: 'offline' }, { status: 503 });
    if (path.startsWith('/v1/public-shares?')) return Response.json({ publicShares: [] });
    return null;
  } });
  serverId = home.home.id;
  session.serverId = serverId;
  await home.hydrateAccountSettings();
  return { home, serverId, session,
    setSessionProjectAccess: (access: typeof sessionProjectAccess) => { sessionProjectAccess = access; },
    recover: () => { failAttachment = false; }, readSource: () => source,
    makeProjectCatalogUnavailable: () => { projectCatalogUnavailable = true; },
    resolveUnknownSourceAsReadOnly: () => { unknownSourceResolved = true; },
    refuseDecision: (refusal: typeof decisionRefusal) => { decisionRefusal = refusal; } };
}

