import type { ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionSurfaceSchema } from '@happier-dev/protocol/actions/metadata';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import '../../../../../ui/sources/dev/vitestSetup';
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from 'vitest';
import { Server } from 'socket.io';
import type { Prisma } from '@prisma/client';
import { io } from 'socket.io-client';
import { createLightSqliteHarness } from '../../../../../server/sources/testkit/lightSqliteHarness';
import { createAuthenticatedTestApp } from '../../../../../server/sources/app/api/testkit/sqliteFastify';
import { accountRoutes } from '../../../../../server/sources/app/api/routes/account/accountRoutes';
import { artifactsRoutes } from '../../../../../server/sources/app/api/routes/artifacts/artifactsRoutes';
import { getOrCreateServerIdentityId, initializeServerIdentityCache } from '../../../../../server/sources/app/serverIdentity/serverIdentity';
import { enableOptionalStatics } from '../../../../../server/sources/app/api/utils/enableOptionalStatics';
import { auth } from '../../../../../server/sources/app/auth/auth';
import { db } from '../../../../../server/sources/storage/db';
import { observeSqliteRequests } from '../../../../../server/sources/testkit/observeSqliteRequests';
import * as requestPrincipalOwner from '../../../../../server/sources/app/api/utils/verifyRequestPrincipal';
import { eventRouter } from '../../../../../server/sources/app/events/connectionEventRouter';
import { getAccountStoredContentV3SocketRoom } from '../../../../../server/sources/app/api/socketRooms';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '../../../../../ui/sources/dev/testkit/harness/homeGovernanceHarness';
import { installWebLockManagerMock } from '../../../../../ui/sources/auth/storage/tokenStorage.web.testHelpers';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { reloadConfiguration } from '@/configuration';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { bootstrapAccountSettingsContext, resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { featuresRoutes } from '../../../../../server/sources/app/api/routes/features/featuresRoutes';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { describeApprovalRequestFields } from '@happier-dev/protocol/actions';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1, McpServerCatalogRowReadResponseV1Schema, McpServerCatalogV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { skillFileFromBytesV1 } from '@happier-dev/protocol/prompts/library/skills/skillZipV1';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema, buildPromptLibraryPhysicalKeyV1, PROMPT_LIBRARY_ROWS_ROUTE_V1,
  PromptLibraryRowReadResponseV1Schema, openPromptLibraryContentV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';

const flowSql = vi.hoisted(() => ({ statements: 0 }));
// Observe physical IO without replacing Prisma's real SQLite adapter.
vi.mock('../../../../../server/generated/sqlite-client/index.js', async importOriginal => {
  const original = await importOriginal<typeof import('@prisma/client')>();
  return { ...original, PrismaClient: class extends original.PrismaClient<Prisma.PrismaClientOptions, 'query'> {
    constructor(options: Prisma.PrismaClientOptions) {
      super({ ...options, log: [{ emit: 'event', level: 'query' }] });
      this.$on('query', () => { flowSql.statements++; });
    }
  } };
});

// Only device credential storage and endpoint selection are substituted. Every
// Artifact and entity-row request reaches the real authenticated HTTP/SQLite owners.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { loadSyncSingletonForTests } = await import('../../../../../ui/sources/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { TokenStorage } = await import('../../../../../ui/sources/auth/storage/tokenStorage');
const { createDefaultActionExecutor } = await import('../../../../../ui/sources/sync/ops/actions/defaultActionExecutor');
const { setRuntimeFetch } = await import('../../../../../ui/sources/utils/system/runtimeFetch');

describe('CLI capability approval replayed by the app', () => {
  let sqlite: Awaited<ReturnType<typeof createLightSqliteHarness>>;
  beforeAll(async () => {
    sqlite = await createLightSqliteHarness({ tempDirPrefix: 'happier-skill-rule-app-replay-', initAuth: true, initEncrypt: true });
  }, 0);
  afterAll(async () => { await homes.reset(); if (sqlite) await sqlite.close(); });

  const replayApproval = async (family: 'skill' | 'MCP' | 'prompt', miswired: boolean, requireInitialReadShape = false) => {
    let phase = 'setup';
    onTestFailed(() => { console.info(`[capability-approval-replay] ${family}, miswired=${miswired}, phase=${phase}`); });
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_SERVER_UI_DIR', 'HAPPIER_SERVER_UI_REQUIRED']);
    const locks = installWebLockManagerMock();
    const app = createAuthenticatedTestApp({ authentication: 'real' }) as import('../../../../../server/sources/app/api/types').Fastify;
    const admissions = vi.spyOn(requestPrincipalOwner, 'verifyRequestPrincipal');
    let counting = false;
    let measuredApprovalPath = '';
    let approvalWriteRequestStarted = false;
    let approvalGetsBeforeFirstWriteRequest = 0;
    let initialApprovalGets = 0;
    const httpCounts = new Map<string, number>();
    const dbCounts = new Map<string, number>();
    app.addHook('onRequest', async request => {
      if (!counting) return;
      const key = `${request.method} ${request.url}`;
      httpCounts.set(key, (httpCounts.get(key) ?? 0) + 1);
      if (request.url === measuredApprovalPath) {
        if (request.method === 'POST') approvalWriteRequestStarted = true;
        if (request.method === 'GET' && !approvalWriteRequestStarted) approvalGetsBeforeFirstWriteRequest++;
      }
    });
    const stopDbObservation = observeSqliteRequests({ before: request => {
      if (!counting) return;
      const key = `${request.model ?? 'raw'}.${request.action}`;
      dbCounts.set(key, (dbCounts.get(key) ?? 0) + 1);
    } });
    const measureApproval = async <T,>(phase: string, artifactId: string, operation: () => Promise<T>): Promise<T> => {
      if (family !== 'skill' || miswired) return operation();
      httpCounts.clear(); dbCounts.clear();
      measuredApprovalPath = `/v1/artifacts/${artifactId}`;
      approvalWriteRequestStarted = false; approvalGetsBeforeFirstWriteRequest = 0;
      const initialAdmissions = admissions.mock.calls.length;
      const initialSql = flowSql.statements;
      counting = true;
      try {
        const result = await operation();
        const requests = [...httpCounts.values()].reduce((sum, count) => sum + count, 0);
        // Each real HTTP ingress admits once; lifecycle steps do not multiply it.
        expect(admissions.mock.calls.length - initialAdmissions).toBe(requests);
        expect(httpCounts.get(`POST ${PROMPT_LIBRARY_ROWS_ROUTE_V1}/skill-rules`) ?? 0)
          .toBe(phase === 'first decision' ? 1 : 0);
        if (phase === 'settled decision') {
          const approvalGets = httpCounts.get(`GET ${measuredApprovalPath}`) ?? 0;
          expect(approvalGets).toBe(1);
          // One real Artifact row acquisition for the one demanded resource.
          // SQL totals include auth/configuration/transaction work and are not ceilings.
          const artifactReads = [...dbCounts].filter(([key]) => key.startsWith('Artifact.find'))
            .reduce((sum, [, count]) => sum + count, 0);
          expect(artifactReads).toBe(approvalGets);
          expect([...httpCounts.keys()].filter(key => key.startsWith('POST '))).toEqual([]);
        }
        return result;
      } finally {
        counting = false;
        if (phase === 'first decision') initialApprovalGets = approvalGetsBeforeFirstWriteRequest;
        console.info('[FLOWBUDGET phone approval]', JSON.stringify({ phase,
          http: Object.fromEntries(httpCounts), admission: admissions.mock.calls.length - initialAdmissions,
          sql: flowSql.statements - initialSql, database: Object.fromEntries(dbCounts), approvalGetsBeforeFirstWriteRequest }));
      }
    };
    const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 1 } });
    for (const key of PromptLibraryCatalogKeyV1Schema.options) await db.userKVStore.create({ data: {
      accountId: account.id, key: buildPromptLibraryPhysicalKeyV1(key), version: 1,
      value: new TextEncoder().encode(JSON.stringify({ t: 'plain', v: emptyPromptLibraryRecordV1(key) })),
    } });
    const credentials = { token: await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' }), encryption: null,
      ...(family === 'prompt' ? { credentialProvenance: 'stored_session' as const } : {}) };
    const machineId = 'skill-rule-machine';
    const sockets = new Server(app.server, { path: '/v1/updates' });
    let promptWriteAttempted = false;
    sockets.use((socket, next) => {
      void (async () => {
        const token: unknown = socket.handshake.auth.token;
        const verified = typeof token === 'string' ? await auth.verifyTokenForRoute(token) : null;
        if (verified?.userId !== account.id) return next(new Error('Unauthorized'));
        await socket.join(getAccountStoredContentV3SocketRoom(account.id)); next();
      })().catch(next);
    });
    eventRouter.setIo(sockets);
    let observer: ReturnType<typeof io> | undefined;
    let profileId: string | undefined;
    try {
      env.patch({ HAPPIER_SERVER_UI_DIR: undefined, HAPPIER_SERVER_UI_REQUIRED: '0' });
      enableOptionalStatics(app); accountRoutes(app); artifactsRoutes(app);
      if (family === 'prompt') { await initializeServerIdentityCache(); featuresRoutes(app); }
      if (family === 'prompt' && miswired) app.addHook('preValidation', async request => {
        // Wrong HTTP binding control: the strict Home route receives no mutation operands.
        if (request.method === 'POST' && request.url === `${PROMPT_LIBRARY_ROWS_ROUTE_V1}/invocations`) {
          promptWriteAttempted = true;
          request.body = {};
        }
      });
      const url = await app.listen({ port: 0, host: '127.0.0.1' });
      env.patch({ HAPPIER_HOME_DIR: `${sqlite.baseDir}/cli-home-${miswired}`, HAPPIER_SERVER_URL: url, HAPPIER_WEBAPP_URL: url });
      reloadConfiguration(); resetInMemoryAccountSettingsContextForTests();
      observer = io(url, { path: '/v1/updates', transports: ['websocket'], auth: { token: credentials.token }, reconnection: false });
      await new Promise<void>((resolve, reject) => { observer!.once('connect', resolve); observer!.once('connect_error', reject); });
      const hints: unknown[] = []; observer.on('update', value => hints.push(value));
      const request = (path: string, init?: RequestInit) => fetch(`${url}${path}`, { ...init, headers: {
        ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...Object.fromEntries(new Headers(init?.headers)),
        authorization: `Bearer ${credentials.token}`, 'content-type': 'application/json',
      } });
      profileId = await homes.addHome({ name: 'Skill rules replay', serverUrl: url, accountId: account.id, currentAccount: true });
      vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: credentials.token });
      for (const path of ['/v2/account/settings', '/v1/account/encryption', '/v1/account/encryption/currentness', PROMPT_LIBRARY_ROWS_ROUTE_V1]) {
        homes.answer(profileId, path, { select: async () => {
          const response = await request(path); return { status: response.status, body: await response.json() };
        } });
      }
      const rulePath = `${PROMPT_LIBRARY_ROWS_ROUTE_V1}/skill-rules`;
      const ruleWriteStatuses: number[] = [];
      homes.answer(profileId, rulePath, { select: async input => {
        const response = await request(rulePath, { method: 'POST', body: JSON.stringify(miswired ? {} : input) });
        ruleWriteStatuses.push(response.status);
        return { status: response.status, body: await response.json() };
      } });
      setRuntimeFetch(homes.request);
      await runWithServerHttpBaseUrl(url, async () => {
        await bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force' });
        const deps = createCliActionDeps({ credentials, token: credentials.token, sessionId: 'cli-global', mode: 'plain', ctx: null });
        const cli = createActionExecutor(deps);
        const appExecutor = createDefaultActionExecutor({ resolveServerIdForSessionId: () => null });
        homes.answer(profileId!, '/v1/artifacts', { select: async input => {
          const response = await request('/v1/artifacts', input === null ? undefined : { method: 'POST', body: JSON.stringify(input) });
          return { status: response.status, body: await response.json() };
        } });
        if (family === 'skill') {
        const seed = await createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"skills.create": Object.keys(ActionSurfaceSchema.shape), "skills.rules.set": Object.keys(ActionSurfaceSchema.shape), "approval.request.decide": Object.keys(ActionSurfaceSchema.shape), "prompts.invocation.create": Object.keys(ActionSurfaceSchema.shape), "prompts.invocation.update": Object.keys(ActionSurfaceSchema.shape), "prompts.invocation.delete": Object.keys(ActionSurfaceSchema.shape), "mcp.servers.list": Object.keys(ActionSurfaceSchema.shape), "mcp.servers.create": Object.keys(ActionSurfaceSchema.shape), "mcp.servers.tools.set": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }), ...deps }).execute('skills.create', {
          name: 'approval-replay', files: [skillFileFromBytesV1('SKILL.md', new TextEncoder().encode('---\nname: approval-replay\n---\nA rule replay skill.'), 0o644)],
          where: { kind: 'replace', rules: [] },
        }, { surface: 'cli', authority: 'account_automation' });
        expect(seed, JSON.stringify(seed)).toMatchObject({ ok: true });
        if (!seed.ok) throw new Error('Skill seed failed');
        const skill = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.create'].parse(seed.result);
        const input = getActionSpec('skills.rules.set').inputSchema.parse({ items: [{ skillId: skill.skillId }],
          change: { kind: 'write', write: { place: { t: 'machine', machineId }, state: 'on' } } });
        const proposed = await cli.execute('skills.rules.set', input, { surface: 'cli', authority: 'account_automation',
          serverId: profileId, runtimeAccountId: account.id, defaultSessionMachineId: machineId,
          actionCaller: { kind: 'host' }, actionRequestId: `cli-rule-${miswired}` });
        expect(proposed, JSON.stringify(proposed)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        if (!proposed.ok || typeof proposed.result !== 'object' || !proposed.result || !('artifactId' in proposed.result)
          || typeof proposed.result.artifactId !== 'string') throw new Error('Missing CLI approval');
        const artifactId = proposed.result.artifactId;
        const stored = ApprovalRequestV2Schema.parse(await deps.approvalsGet!({ artifactId }));
        expect(stored).toMatchObject({ status: 'open', createdBy: { surface: 'cli' }, actionArgs: input,
          executionOriginV1: { machineId } });
        // Forward the app's Artifact persistence boundary to the same real Home
        // used by the CLI. The canonical harness retains platform admission only.
        for (const path of ['/v1/artifacts', ...[artifactId, skill.skillId].flatMap(id => [
          `/v1/artifacts/${id}`, `/v1/artifacts/${id}/recipients`, `/v1/artifacts/${id}/content`,
        ])]) homes.answer(profileId!, path, { select: async input => {
          const response = await request(path, input === null ? undefined : { method: 'POST', body: JSON.stringify(input) });
          return { status: response.status, body: await response.json() };
        } });
        const decided = await measureApproval('first decision', artifactId, () => appExecutor.execute('approval.request.decide', { artifactId, decision: 'approve' }, { surface: 'ui', serverId: profileId }));
        const row = PromptLibraryRowReadResponseV1Schema.parse(await (await request(rulePath)).json());
        if (row.status !== 'present') throw new Error('Rules row unavailable');
        const opened = openPromptLibraryContentV1({ key: 'skill-rules', content: row.content, mode: 'plain', material: null });
        if (opened.status !== 'opened' || opened.record.key !== 'skill-rules') throw new Error('Rules row unreadable');
        const rules = opened.record.value;
        if (miswired) {
          expect(decided).toMatchObject({ ok: true, result: { execution: { result: { ok: false } } } });
          expect(ruleWriteStatuses).toContain(400);
          expect(rules.rules.filter(rule => rule.skillId === skill.skillId)).toEqual([]);
        } else {
          expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
          const settled = ApprovalRequestV2Schema.parse(await deps.approvalsGet!({ artifactId }));
          expect(settled.actionArgs).toEqual(input);
          expect(describeApprovalRequestFields(settled)).toEqual(describeApprovalRequestFields(stored));
          expect(rules.rules.filter(rule => rule.skillId === skill.skillId)).toEqual([expect.objectContaining({ skillId: skill.skillId, enabled: true, target: { t: 'machine', machineId } })]);
          expect(hints.length).toBeGreaterThan(0);
          const again = await measureApproval('settled decision', artifactId, () => appExecutor.execute('approval.request.decide', { artifactId, decision: 'approve' }, { surface: 'ui', serverId: profileId }));
          expect(again).toMatchObject({ ok: true, result: { status: 'executed' } });
          await expect(appExecutor.execute('skills.rules.set', { ...input,
            change: { kind: 'write', write: { place: { t: 'machine', machineId }, state: 'inherit' } } }, { surface: 'ui', serverId: profileId }))
            .resolves.toMatchObject({ ok: true, result: { ok: true, items: [{ rules: [] }] } });
          const restored = PromptLibraryRowReadResponseV1Schema.parse(await (await request(rulePath)).json());
          if (restored.status !== 'present') throw new Error('Restored rules row unavailable');
          const content = openPromptLibraryContentV1({ key: 'skill-rules', content: restored.content, mode: 'plain', material: null });
          if (content.status !== 'opened' || content.record.key !== 'skill-rules') throw new Error('Restored rules row unreadable');
          expect(content.record.value.rules.filter(rule => rule.skillId === skill.skillId)).toEqual([]);
        }
        } else if (family === 'prompt') {
          // Real CLI composition, authenticated Home HTTP, strict catalog CAS and
          // durable approvals. No mounted app or substituted replay executor.
          const serverIdentityId = await getOrCreateServerIdentityId();
          expect(FeaturesResponseSchema.parse(await (await request('/v1/features/authenticated')).json())
            .capabilities.serverIdentity.serverIdentityId).toBe(serverIdentityId);
          const terminal = createCliActionExecutorFromCredentials({ credentials, serverId: profileId!, serverApiUrl: url,
            serverIdentityId, readCredentials: async () => credentials });
          const readInvocations = async () => {
            const row = PromptLibraryRowReadResponseV1Schema.parse(await (await request(`${PROMPT_LIBRARY_ROWS_ROUTE_V1}/invocations`)).json());
            if (row.status !== 'present') throw new Error('Missing invocation catalog');
            const opened = openPromptLibraryContentV1({ key: 'invocations', content: row.content, mode: 'plain', material: null });
            if (opened.status !== 'opened' || opened.record.key !== 'invocations') throw new Error('Unreadable invocation catalog');
            return { revision: row.revision, entries: opened.record.value.entries };
          };
          let invocationId = '';
          for (const actionId of ['prompts.invocation.create', 'prompts.invocation.update', 'prompts.invocation.delete'] as const) {
            const before = await readInvocations();
            const fields = { token: actionId.endsWith('create') ? 'daily' : 'weekly', title: 'Review', target: { kind: 'doc', artifactId: 'doc' } };
            const input = getActionSpec(actionId).inputSchema.parse(actionId.endsWith('create') ? fields
              : { invocationId, expectedRevision: before.revision, ...(actionId.endsWith('update') ? fields : {}) });
            phase = `${actionId} proposal`;
            const proposed = await terminal.execute(actionId, input, { surface: 'cli', authority: 'account_automation',
              serverId: profileId, serverIdentityId, actionRequestId: `prompt-${actionId}`, actionCaller: { kind: 'host' } });
            expect(proposed, JSON.stringify(proposed)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
            if (!proposed.ok || !proposed.result || typeof proposed.result !== 'object' || !('artifactId' in proposed.result)
              || typeof proposed.result.artifactId !== 'string') throw new Error('Missing prompt approval');
            const artifactId = proposed.result.artifactId;
            expect(await readInvocations()).toEqual(before);
            const approval = ApprovalRequestV2Schema.parse(await deps.approvalsGet!({ artifactId }));
            expect(approval.actionArgs).toEqual(input);
            phase = `${actionId} CLI decision`;
            const decided = await terminal.execute('approval.request.decide', { artifactId, decision: 'approve' }, {
              surface: 'cli', authority: 'present_user', serverId: profileId, serverIdentityId,
            });
            if (miswired) {
              expect(promptWriteAttempted).toBe(true);
              expect(decided).not.toMatchObject({ ok: true, result: { status: 'executed', execution: { result: { status: 'updated' } } } });
              expect(await readInvocations()).toEqual(before);
              break;
            }
            expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
            const settled = ApprovalRequestV2Schema.parse(await deps.approvalsGet!({ artifactId }));
            if (!settled.execution?.ok) throw new Error('Prompt approval did not execute');
            const receipt = getActionSpec(actionId).outputSchema!.parse(settled.execution.result);
            expect(receipt).toMatchObject({ status: 'updated' });
            if (!receipt || typeof receipt !== 'object' || !('invocationId' in receipt) || typeof receipt.invocationId !== 'string') throw new Error('Missing shortcut identity');
            invocationId = receipt.invocationId;
            const after = await readInvocations();
            expect(after.revision).toBe(before.revision + 1);
            expect(after.entries).toMatchObject(actionId.endsWith('delete') ? [] : [{ id: invocationId, token: actionId.endsWith('create') ? '/daily' : '/weekly' }]);
            await terminal.execute('approval.request.decide', { artifactId, decision: 'approve' }, { surface: 'cli', authority: 'present_user', serverId: profileId, serverIdentityId });
            expect(await readInvocations()).toEqual(after);
          }
        } else {
        // The same production CLI/app wiring owns MCP approval replay. Only the
        // authenticated HTTP boundary is forwarded; catalog policy/CAS stays real.
        const mcpId = `review-mcp-${miswired}`;
        const catalogRead = await cli.execute('mcp.servers.list', {}, { surface: 'cli', authority: 'account_automation' });
        if (!catalogRead.ok) throw new Error('MCP catalog seed read failed');
        const catalog = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.list'].parse(catalogRead.result);
        if (catalog.status !== 'ready') throw new Error('MCP catalog seed is not ready');
        await expect(createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"skills.create": Object.keys(ActionSurfaceSchema.shape), "skills.rules.set": Object.keys(ActionSurfaceSchema.shape), "approval.request.decide": Object.keys(ActionSurfaceSchema.shape), "prompts.invocation.create": Object.keys(ActionSurfaceSchema.shape), "prompts.invocation.update": Object.keys(ActionSurfaceSchema.shape), "prompts.invocation.delete": Object.keys(ActionSurfaceSchema.shape), "mcp.servers.list": Object.keys(ActionSurfaceSchema.shape), "mcp.servers.create": Object.keys(ActionSurfaceSchema.shape), "mcp.servers.tools.set": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }), ...deps }).execute('mcp.servers.create', {
          expectedRevision: catalog.revision, entry: { id: mcpId, name: `review_${miswired}`, title: 'Issue tracker', transport: 'stdio',
            stdio: { command: 'issue-mcp', args: ['--workspace', 'team'] }, env: {}, createdAt: 1, updatedAt: 1 },
          where: { kind: 'replace', rules: [] },
        }, { surface: 'cli', authority: 'account_automation' })).resolves.toMatchObject({ ok: true, result: { status: 'updated' } });
        const mcpInput = getActionSpec('mcp.servers.tools.set').inputSchema.parse({ serverId: mcpId, tools: { delete_issue: 'allow' } });
        const mcpProposed = await cli.execute('mcp.servers.tools.set', mcpInput, { surface: 'cli', authority: 'account_automation',
          serverId: profileId, runtimeAccountId: account.id, defaultSessionMachineId: machineId,
          actionCaller: { kind: 'host' }, actionRequestId: `cli-mcp-${miswired}` });
        expect(mcpProposed).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        if (!mcpProposed.ok || !mcpProposed.result || typeof mcpProposed.result !== 'object' || !('artifactId' in mcpProposed.result)
          || typeof mcpProposed.result.artifactId !== 'string') throw new Error('Missing MCP approval');
        const mcpArtifactId = mcpProposed.result.artifactId;
        const mcpStored = ApprovalRequestV2Schema.parse(await deps.approvalsGet!({ artifactId: mcpArtifactId }));
        const pendingMcp = describeApprovalRequestFields(mcpStored);
        expect(pendingMcp.rows).toContainEqual(expect.objectContaining({ title: 'MCP server', reference: { kind: 'mcpServer', id: mcpId } }));
        expect(JSON.stringify(pendingMcp)).toContain('delete_issue');
        expect(JSON.stringify(pendingMcp)).toContain('Allow');
        for (const path of [`/v1/artifacts/${mcpArtifactId}`, `/v1/artifacts/${mcpArtifactId}/recipients`, `/v1/artifacts/${mcpArtifactId}/content`]) {
          homes.answer(profileId!, path, { select: async input => {
            const response = await request(path, input === null ? undefined : { method: 'POST', body: JSON.stringify(input) });
            return { status: response.status, body: await response.json() };
          } });
        }
        const mcpWriteStatuses: number[] = [];
        homes.answer(profileId!, MCP_SERVER_CATALOG_ROWS_ROUTE_V1, { select: async input => {
          const response = await request(MCP_SERVER_CATALOG_ROWS_ROUTE_V1, input === null ? undefined
            : { method: 'POST', body: JSON.stringify(miswired ? {} : input) });
          if (input !== null) mcpWriteStatuses.push(response.status);
          return { status: response.status, body: await response.json() };
        } });
        phase = 'MCP approval decision';
        const mcpDecided = await appExecutor.execute('approval.request.decide', { artifactId: mcpArtifactId, decision: 'approve' }, { surface: 'ui', serverId: profileId });
        const readMcp = async () => {
          const row = McpServerCatalogRowReadResponseV1Schema.parse(await (await request(MCP_SERVER_CATALOG_ROWS_ROUTE_V1)).json());
          if (row.status !== 'present' || row.content.t !== 'plain') throw new Error('MCP catalog unavailable');
          return McpServerCatalogV1Schema.parse(row.content.v).servers.find(server => server.id === mcpId);
        };
        if (miswired) {
          expect(mcpDecided).toMatchObject({ ok: true, result: { status: 'failed', execution: { ok: false, errorCode: 'mcp_catalog_operation_failed' } } });
          expect(mcpWriteStatuses).toContain(400);
          expect((await readMcp())?.tools?.overrides?.delete_issue).toBeUndefined();
        } else {
          expect(mcpDecided, JSON.stringify(mcpDecided)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
          expect((await readMcp())?.tools?.overrides.delete_issue).toBe('allow');
          const settledMcp = ApprovalRequestV2Schema.parse(await deps.approvalsGet!({ artifactId: mcpArtifactId }));
          expect(describeApprovalRequestFields(settledMcp)).toEqual(pendingMcp);
          phase = 'MCP repeated approval';
          await expect(appExecutor.execute('approval.request.decide', { artifactId: mcpArtifactId, decision: 'approve' }, { surface: 'ui', serverId: profileId }))
            .resolves.toMatchObject({ ok: true, result: { status: 'executed' } });
          phase = 'MCP policy restoration';
          // Restore through a separately approved invocation as well. A bare UI
          // call can legitimately await mounted host confirmation, absent here.
          const restoration = await cli.execute('mcp.servers.tools.set', { serverId: mcpId, tools: { delete_issue: 'inherit' } }, {
            surface: 'cli', authority: 'account_automation', serverId: profileId, runtimeAccountId: account.id,
            defaultSessionMachineId: machineId, actionCaller: { kind: 'host' }, actionRequestId: 'cli-mcp-restore',
          });
          expect(restoration).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
          if (!restoration.ok || !restoration.result || typeof restoration.result !== 'object' || !('artifactId' in restoration.result)
            || typeof restoration.result.artifactId !== 'string') throw new Error('Missing MCP restoration approval');
          const restoreArtifactId = restoration.result.artifactId;
          for (const path of [`/v1/artifacts/${restoreArtifactId}`, `/v1/artifacts/${restoreArtifactId}/recipients`, `/v1/artifacts/${restoreArtifactId}/content`]) {
            homes.answer(profileId!, path, { select: async input => {
              const response = await request(path, input === null ? undefined : { method: 'POST', body: JSON.stringify(input) });
              return { status: response.status, body: await response.json() };
            } });
          }
          await expect(appExecutor.execute('approval.request.decide', { artifactId: restoreArtifactId, decision: 'approve' }, { surface: 'ui', serverId: profileId }))
            .resolves.toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
          expect((await readMcp())?.tools?.overrides.delete_issue).toBeUndefined();
        }
        }
      });
      if (requireInitialReadShape) {
        phase = 'FLOWBUDGET initial approval acquisition';
        expect(initialApprovalGets).toBe(1);
      }
    } finally {
      // Retire captured readers and close only this fixture's HTTP keep-alives
      // before Socket.IO waits for its shared HTTP server to shut down.
      await homes.reset();
      stopDbObservation();
      observer?.disconnect(); app.server.closeAllConnections(); await sockets.close(); await app.close();
      vi.restoreAllMocks(); locks.restore(); env.restore(); reloadConfiguration();
      resetInMemoryAccountSettingsContextForTests();
    }
  };

  it.each([['skill', false], ['skill', true], ['MCP', false], ['MCP', true], ['prompt', false], ['prompt', true]] as const)(
    'writes and restores %s through original Account custody (miswired storage: %s)',
    (family, miswired) => replayApproval(family, miswired));

  // App approval/Artifact acquisition cleanup: reuse the admitted unchanged
  // approval before its first write; later real CAS state transitions are distinct.
  it('FLOWBUDGET phone approval acquires the unchanged request once before its first write (app approval/Artifact acquisition cleanup)',
    () => replayApproval('skill', false, true));
});
