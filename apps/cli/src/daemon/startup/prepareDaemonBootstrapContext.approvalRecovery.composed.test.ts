import { afterEach, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { TargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { FilesystemReadFileInputSchema } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { AuthTokenProvenanceAnySchema } from '@happier-dev/protocol/auth/authToken';
import { AccountEncryptionModeResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { decodeArtifactKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { configuration } from '@/configuration';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { artifactListResponse, artifactReadResponse } from '@/testkit/http/artifactHome';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { acquireDaemonLock, releaseDaemonLock, writeStoredCredentialsForServerId, type StoredCredentials } from '@/persistence';
import { ensureMachineIdForCredentials } from '@/ui/auth';
import { prepareDaemonBootstrapContext } from './prepareDaemonBootstrapContext';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); resetServerFeaturesClientForTests(); });

it.each(['plain', 'e2ee'] as const)('settles only daemon-owned executing approvals at startup without executing any Action (%s)', async mode => {
  vi.stubEnv('HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED', 'false');
  vi.stubEnv('HAPPIER_MACHINE_TRANSFER_TAILSCALE_SERVE_ENABLED', 'false');
  const features = FeaturesResponseSchema.parse({ features: { connectedServices: { enabled: false },
    artifacts: { queryHints: { enabled: true } } }, capabilities: {} });
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(features)));
  const app = fastify();
  const origin = 'http://approval-restart.test';
  const rows = new Map<string, Record<string, unknown> & { id: string }>();
  const approvalStates = new Map<string, unknown>();
  const approvalKinds = new Map<string, unknown>();
  const selections: URLSearchParams[] = [];
  const bodySelections: string[][] = [];
  const missingRoutes: string[] = [];
  app.setNotFoundHandler((request, reply) => {
    missingRoutes.push(`${request.method} ${request.url}`);
    return reply.code(404).send({ error: 'fixture_route_not_found' });
  });
  app.get('/v1/account/encryption', async () => AccountEncryptionModeResponseSchema.parse({ mode, updatedAt: 1 }));
  app.get('/v1/features', async () => features);
  app.get('/v1/artifacts', async request => {
    const url = new URL(request.url, origin);
    selections.push(url.searchParams);
    const states: string[] = JSON.parse(url.searchParams.get('approvalStates') ?? '[]');
    const kinds: string[] = JSON.parse(url.searchParams.get('kinds') ?? '[]');
    const selected = [...rows.values()].filter(row => (!states.length || states.includes(String(approvalStates.get(row.id))))
      && (!kinds.length || kinds.includes(String(approvalKinds.get(row.id)))));
    return artifactListResponse(request.url, selected.map(({ body: _body, ...row }) => row));
  });
  app.post('/v1/artifacts/read', async request => {
    const body = request.body as { artifactIds: string[] };
    bodySelections.push(body.artifactIds);
    return artifactReadResponse(request.body, id => rows.get(id) ?? null).data;
  });
  app.get<{ Params: { id: string } }>('/v1/artifacts/:id', async (request, reply) =>
    rows.get(request.params.id) ?? reply.code(404).send({ error: 'artifact_not_found' }));
  app.post('/v1/artifacts', async request => {
    const body = request.body as Record<string, unknown> & { id: string };
    const { idScope: _idScope, kind: _kind, approvalState: _state, approvalSessionId: _session, ...content } = body;
    approvalStates.set(body.id, _state);
    // Writes carry the encoded storage index; list selectors use its exact kind hint.
    approvalKinds.set(body.id, decodeArtifactKindV1(_kind).kindHint);
    rows.set(body.id, { ...content, ownerAccountId: 'account', access: 'owner', publicAudience: 'none',
      encryptionMode: mode, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
    return { id: body.id, headerVersion: 1, bodyVersion: 1 };
  });
  app.post<{ Params: { id: string } }>('/v1/artifacts/:id', async request => {
    const row = rows.get(request.params.id);
    if (!row) throw new Error('Missing fixture row');
    const body = request.body as Record<string, unknown>;
    if (body.expectedHeaderVersion !== row.headerVersion || body.expectedBodyVersion !== row.bodyVersion) {
      return { success: false, error: 'version-mismatch' };
    }
    const headerVersion = Number(row.headerVersion) + 1;
    const bodyVersion = Number(row.bodyVersion) + 1;
    const { expectedHeaderVersion: _headerCas, expectedBodyVersion: _bodyCas,
      kind: _kind, approvalState: _state, approvalSessionId: _session, ...content } = body;
    if (_state !== undefined) approvalStates.set(row.id, _state);
    rows.set(row.id, { ...row, ...content, headerVersion, bodyVersion });
    return { success: true, headerVersion, bodyVersion };
  });
  await app.ready();
  const restoreHttp = installAxiosFastifyAdapter({ app, origin });
  const provenance = AuthTokenProvenanceAnySchema.parse({ v: 1, kind: 'terminal', authority: 'account_automation' });
  const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'account', provenance })).toString('base64url')}.signature`;
  const credentials: StoredCredentials = { token,
    encryption: mode === 'plain' ? null : { type: 'legacy', secret: new Uint8Array(32).fill(7) } };
  await writeStoredCredentialsForServerId(configuration.activeServerId, credentials);
  const { machineId: ownMachineId } = await ensureMachineIdForCredentials(credentials);
  const lock = await acquireDaemonLock(5, 200);
  if (!lock) throw new Error('Missing test daemon lock');
  try {
    await runWithServerHttpBaseUrl(origin, async () => {
      const store = createCliApprovalsArtifactStore({ credentials });
      const seed = async (machineId: string, requestId: string, status: 'executing' | 'approved', liveOnly = false) => {
        const request = TargetActionApprovalRequestV1Schema.parse({ v: 1, kind: 'plugin_target_action', status: 'open',
          createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'cli' }, requestedSurface: 'cli',
          qualifiedActionId: 'acme.alpha/actions/write', input: {}, secretInputPaths: [],
          ...(liveOnly ? { approvalInputCustody: 'live_only' } : {}),
          sourceCustody: { kind: 'development', registeredRootId: 'root' },
          policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64), summary: 'Write',
          replayPlacement: { serverId: configuration.activeServerId, machineId },
          executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
            serverId: configuration.activeServerId, accountId: 'account', machineId, actionId: 'action.invoke', requestId } });
        const { artifactId } = await store.targetActionApprovalsCreate({ request });
        const approved = TargetActionApprovalRequestV1Schema.parse({ ...request, status: 'approved', decision: { kind: 'approve', decidedAtMs: 2 } });
        expect(await store.targetActionApprovalsUpdate({ artifactId, request: approved })).toEqual({ ok: true });
        if (status === 'executing') expect(await store.targetActionApprovalsUpdate({ artifactId,
          request: { ...approved, status: 'executing' } })).toEqual({ ok: true });
        return artifactId;
      };
      const own = await seed(ownMachineId, 'own-claimed', 'executing');
      const other = await seed('machine-2', 'other-claimed', 'executing');
      const unclaimed = await seed(ownMachineId, 'own-unclaimed', 'approved');
      const sessionClaim = await seed(ownMachineId, 'live-session-claim', 'executing', true);
      const seedBuiltIn = async (machineId: string, requestId: string, status: 'executing' | 'approved') => {
        const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
          createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId: 'daemon.filesystem.readFile',
          actionArgs: FilesystemReadFileInputSchema.parse({ rootPath: '/fixture', path: 'file' }), summary: 'Read file',
          executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
            serverId: configuration.activeServerId, accountId: 'account', machineId,
            actionId: 'daemon.filesystem.readFile', requestId } });
        const { artifactId } = await store.approvalsCreate({ request, serverId: null });
        const approved = ApprovalRequestV2Schema.parse({ ...request, status: 'approved',
          decision: { kind: 'approve', decidedAtMs: 2 } });
        expect(await store.approvalsUpdate({ artifactId, request: approved, serverId: null })).toEqual({ ok: true });
        if (status === 'executing') expect(await store.approvalsUpdate({ artifactId,
          request: { ...approved, status: 'executing' }, serverId: null })).toEqual({ ok: true });
        return artifactId;
      };
      const builtInOwn = await seedBuiltIn(ownMachineId, 'own-built-in-claimed', 'executing');
      const builtInOther = await seedBuiltIn('machine-2', 'other-built-in-claimed', 'executing');
      const builtInUnclaimed = await seedBuiltIn(ownMachineId, 'own-built-in-unclaimed', 'approved');
      const bootstrap = await prepareDaemonBootstrapContext({ daemonLockHandle: lock,
        initialMachineMetadata: { host: 'fixture', platform: 'linux', happyCliVersion: '0.0.0',
          homeDir: configuration.happyHomeDir, happyHomeDir: configuration.happyHomeDir,
          happyLibDir: configuration.happyHomeDir }, startupSource: 'manual' });
      expect(bootstrap.machineId).toBe(ownMachineId);
      const states = (selection: URLSearchParams) => selection.get('approvalStates');
      expect(selections.filter(selection => states(selection) === JSON.stringify(['executing'])),
        'Startup must reach its one recovery selection').toHaveLength(1);
      // Startup also starts the one-time list-fact classification of open built-in headers (none here).
      await vi.waitFor(() => expect(selections.filter(selection => states(selection) === JSON.stringify(['open'])).map(selection =>
        selection.get('kinds'))).toEqual([JSON.stringify(['approval_request.v1'])]));
      expect(missingRoutes, 'The HTTP boundary must implement every reached route').toEqual([]);
      expect(bodySelections).toHaveLength(1);
      expect(bodySelections[0]).toHaveLength(3);
      expect(bodySelections[0]).toEqual(expect.arrayContaining([own, sessionClaim, builtInOwn]));
      expect(await store.targetActionApprovalsGet({ artifactId: own })).toMatchObject({ status: 'outcome_unknown',
        execution: { ok: false, effectAttempted: true, errorCode: 'approval_execution_outcome_unknown' } });
      expect(await store.approvalsGet({ artifactId: own, serverId: null })).toMatchObject({ status: 'outcome_unknown',
        execution: { ok: false, effectAttempted: true, errorCode: 'approval_execution_outcome_unknown' } });
      expect(await store.targetActionApprovalsGet({ artifactId: other })).toMatchObject({ status: 'executing' });
      expect(await store.targetActionApprovalsGet({ artifactId: unclaimed })).toMatchObject({ status: 'approved' });
      expect(await store.targetActionApprovalsGet({ artifactId: sessionClaim })).toMatchObject({ status: 'executing' });
      expect(await store.approvalsGet({ artifactId: builtInOwn, serverId: null })).toMatchObject({ status: 'outcome_unknown',
        execution: { ok: false, effectAttempted: true, errorCode: 'approval_execution_outcome_unknown' } });
      expect(await store.approvalsGet({ artifactId: builtInOther, serverId: null })).toMatchObject({ status: 'executing' });
      expect(await store.approvalsGet({ artifactId: builtInUnclaimed, serverId: null })).toMatchObject({ status: 'approved' });
      expect(selections[0]?.get('approvalStates')).toBe(JSON.stringify(['executing']));
    });
  } finally { await releaseDaemonLock(lock); restoreHttp(); await app.close(); }
});
