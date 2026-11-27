import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519';
import { expect, it } from 'vitest';
import {
  ApprovalRequestV1Schema,
  ApprovalRequestV2Schema,
  createActionExecutor,
  type ApprovalRequest,
} from '@happier-dev/protocol';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { decodeBase64, decryptWithDataKey, encodeBase64, encryptWithDataKey } from '@/api/encryption';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createEmptyActionAutomationPort } from '@/testkit/actionTransportDeps';
import { createCliApprovalsArtifactStore } from './artifactStore';

function createE2eeCredentials() {
  const machineKey = new Uint8Array(randomBytes(32));
  const payload = Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url');
  return {
    token: `e30.${payload}.sig`,
    encryption: {
      type: 'dataKey' as const,
      machineKey,
      publicKey: x25519.getPublicKey(machineKey),
    },
  };
}

async function createRealApprovalCasServer(initialRequest: ApprovalRequest, credentials: ReturnType<typeof createE2eeCredentials>) {
  const resource = await createResourceDataKey({ credentials, mode: 'e2ee' });
  if (resource.mode !== 'e2ee') throw new Error('Missing encrypted fixture');
  const seal = (value: unknown) => encodeBase64(encryptWithDataKey(value, resource.dataKey), 'base64');
  const open = (value: string) => decryptWithDataKey(decodeBase64(value), resource.dataKey);
  let row = {
    id: 'approval',
    ownerAccountId: 'owner',
    access: 'owner' as const,
    encryptionMode: 'e2ee' as const,
    dataEncryptionKey: resource.dataEncryptionKey,
    header: seal(buildApprovalRequestArtifactHeaderV1(initialRequest)),
    body: seal({ body: JSON.stringify(initialRequest) }),
    headerVersion: 1,
    bodyVersion: 1,
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const counts = { gets: 0, posts: 0, recipients: 0, other: 0 };
  let beforePost: ((input: Readonly<{
    expectedHeaderVersion?: number;
    expectedBodyVersion?: number;
    decodedBody: ApprovalRequest | null;
    postNumber: number;
  }>) => Promise<void> | void) | null = null;

  const home = createServer(async (req, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/v1/artifacts/approval') {
      counts.gets++;
      response.end(JSON.stringify(row));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/artifacts/approval') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        header?: string;
        body?: string;
        expectedHeaderVersion?: number;
        expectedBodyVersion?: number;
      };
      counts.posts++;
      const postNumber = counts.posts;
      let decodedBody: ApprovalRequest | null = null;
      if (typeof payload.body === 'string') {
        const opened = open(payload.body) as { body?: string } | null;
        if (opened && typeof opened.body === 'string') {
          decodedBody = ApprovalRequestV2Schema.safeParse(JSON.parse(opened.body)).data ?? null;
        }
      }
      if (beforePost) {
        await beforePost({
          expectedHeaderVersion: payload.expectedHeaderVersion,
          expectedBodyVersion: payload.expectedBodyVersion,
          decodedBody,
          postNumber,
        });
      }
      if (payload.expectedHeaderVersion !== row.headerVersion || payload.expectedBodyVersion !== row.bodyVersion) {
        response.end(JSON.stringify({
          success: false,
          error: 'version-mismatch',
          currentHeaderVersion: row.headerVersion,
          currentBodyVersion: row.bodyVersion,
        }));
        return;
      }
      row = {
        ...row,
        ...(typeof payload.header === 'string' ? { header: payload.header, headerVersion: row.headerVersion + 1 } : {}),
        ...(typeof payload.body === 'string' ? { body: payload.body, bodyVersion: row.bodyVersion + 1 } : {}),
        seq: row.seq + 1,
        updatedAt: row.updatedAt + 1,
      };
      response.end(JSON.stringify({
        success: true,
        headerVersion: row.headerVersion,
        bodyVersion: row.bodyVersion,
      }));
      return;
    }
    if (req.url === '/v1/artifacts/approval/access/recipients') {
      counts.recipients++;
      response.end(JSON.stringify({
        artifactId: 'approval',
        ownerAccountId: 'owner',
        access: 'owner',
        encryptionMode: 'e2ee',
        dataEncryptionKey: resource.dataEncryptionKey,
        callerDataEncryptionKey: resource.dataEncryptionKey,
        recipients: [],
      }));
      return;
    }
    if (req.url === '/v1/features') {
      response.end(JSON.stringify({ features: {} }));
      return;
    }
    counts.other++;
    response.statusCode = 404;
    response.end('{}');
  });

  await new Promise<void>(resolve => home.listen(0, '127.0.0.1', resolve));
  const address = home.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture HTTP address');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    counts,
    getRow: () => row,
    readStoredRequest: () => {
      const opened = open(row.body) as { body: string };
      return ApprovalRequestV2Schema.parse(JSON.parse(opened.body));
    },
    bumpExternalVersion: (nextRequest: ApprovalRequest) => {
      row = {
        ...row,
        header: seal(buildApprovalRequestArtifactHeaderV1(nextRequest)),
        body: seal({ body: JSON.stringify(nextRequest) }),
        headerVersion: row.headerVersion + 1,
        bodyVersion: row.bodyVersion + 1,
        seq: row.seq + 1,
        updatedAt: row.updatedAt + 1,
      };
    },
    setBeforePost: (fn: typeof beforePost) => { beforePost = fn; },
    close: async () => {
      home.closeAllConnections();
      await new Promise<void>((resolve, reject) => home.close(error => error ? reject(error) : resolve()));
    },
  };
}

function createDeferredV2Approval(status: 'open' | 'approved' = 'open') {
  return ApprovalRequestV2Schema.parse({
    v: 2,
    actionId: 'session.message.send',
    status,
    summary: 'Send message',
    createdAtMs: 1,
    updatedAtMs: status === 'approved' ? 2 : 1,
    createdBy: { surface: 'cli', sessionId: 'session-1' },
    requestedSurface: 'cli',
    approval: { flow: 'deferred', result: 'optional' },
    executionOriginV1: {
      v: 1,
      authority: 'account_automation',
      surface: 'cli',
      caller: { kind: 'host' },
      serverId: 'home-1',
      serverIdentityId: 'srv-home-1',
      accountId: 'owner',
      machineId: 'machine-1',
      sessionId: 'session-1',
      target: { kind: 'session', sessionId: 'session-1' },
      actionId: 'session.message.send',
      requestId: 'req-perf-1',
    },
    actionArgs: { sessionId: 'session-1', message: 'hello' },
    ...(status === 'approved' ? { decision: { kind: 'approve' as const, decidedAtMs: 2 } } : {}),
  });
}

it('reads fresh encrypted approval decisions without invoking recipient repair', async () => {
  const machineKey = new Uint8Array(randomBytes(32));
  const credentials = { token: 'synthetic-token', encryption: { type: 'dataKey' as const,
    machineKey, publicKey: x25519.getPublicKey(machineKey) } };
  const resource = await createResourceDataKey({ credentials, mode: 'e2ee' });
  if (resource.mode !== 'e2ee') throw new Error('Missing encrypted fixture');
  const request = ApprovalRequestV1Schema.parse({ v: 1, actionId: 'session.title.set', status: 'open',
    summary: 'Change title', createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'cli', sessionId: 'session' },
    actionArgs: { sessionId: 'session', title: 'Reviewed title' } });
  const seal = (value: unknown) => encodeBase64(encryptWithDataKey(value, resource.dataKey), 'base64');
  let rawReads = 0;
  let censusReads = 0;
  let summary = request.summary;
  const home = createServer((req, response) => {
    response.setHeader('Content-Type', 'application/json');
    // Real HTTP is the only substituted system boundary; codecs, approval
    // projection and the Account Artifact reader all run unchanged.
    setTimeout(() => {
      if (req.url === '/v1/artifacts/approval') {
        rawReads++;
        const current = { ...request, summary };
        response.end(JSON.stringify({ id: 'approval', ownerAccountId: 'owner', access: 'owner', encryptionMode: 'e2ee',
          dataEncryptionKey: resource.dataEncryptionKey, header: seal(buildApprovalRequestArtifactHeaderV1(current)),
          body: seal({ body: JSON.stringify(current) }), headerVersion: rawReads, bodyVersion: rawReads,
          seq: 1, createdAt: 1, updatedAt: 1 }));
      } else if (req.url === '/v1/artifacts/approval/access/recipients') {
        censusReads++;
        response.end(JSON.stringify({ artifactId: 'approval', ownerAccountId: 'owner', access: 'owner', encryptionMode: 'e2ee',
          dataEncryptionKey: resource.dataEncryptionKey, callerDataEncryptionKey: resource.dataEncryptionKey, recipients: [] }));
      } else { response.statusCode = 404; response.end('{}'); }
    }, 20);
  });
  await new Promise<void>(resolve => home.listen(0, '127.0.0.1', resolve));
  const address = home.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture HTTP address');
  try {
    await runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, async () => {
      const store = createCliApprovalsArtifactStore({ credentials, getAccountEncryptionMode: async () => 'e2ee' });
      for (let sample = 0; sample < 3; sample++) {
        summary = `Review ${sample}`;
        expect(await store.approvalsGet({ artifactId: 'approval', serverId: null })).toMatchObject({ summary });
      }
      expect({ rawReads, censusReads }).toEqual({ rawReads: 3, censusReads: 0 });
    });
  } finally {
    home.closeAllConnections();
    await new Promise<void>((resolve, reject) => home.close(error => error ? reject(error) : resolve()));
  }
});

it('completes a deferred E2EE Daemon approval decision within 5 Artifact HTTP requests and clears basis on version_mismatch', async () => {
  const credentials = createE2eeCredentials();
  const initial = createDeferredV2Approval('open');
  const server = await createRealApprovalCasServer(initial, credentials);
  try {
    await runWithServerHttpBaseUrl(server.baseUrl, async () => {
      const store = createCliApprovalsArtifactStore({ credentials, getAccountEncryptionMode: async () => 'e2ee' });
      let effects = 0;
      const executor = createActionExecutor({
        actionAutomations: createEmptyActionAutomationPort(),
        approvalsGet: store.approvalsGet,
        approvalsUpdate: store.approvalsUpdate,
        isApprovalExecutionOriginCurrent: async () => true,
        sessionSendMessage: async () => {
          effects += 1;
          return { status: 'accepted' as const, localId: 'local-1' };
        },
      });
      const result = await executor.execute('approval.request.decide', {
        artifactId: 'approval',
        decision: 'approve',
      }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home-1', serverIdentityId: 'srv-home-1', runtimeAccountId: 'owner' });

      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
      expect(effects).toBe(1);
      expect(server.readStoredRequest().status).toBe('executed');
      const totalArtifactHttp = server.counts.gets + server.counts.posts + server.counts.recipients;
      expect(server.counts).toEqual({ gets: 1, posts: 3, recipients: 0, other: 0 });
      expect(totalArtifactHttp).toBeLessThanOrEqual(5);
    });
  } finally {
    await server.close();
  }

  // Verify stale cached CAS basis retries exactly once via readFresh() -> evaluateBasis -> POST
  // when the server returns version_mismatch with writeCommitted: false (SEC-COORD-OPUS-1126N F1).
  const open2 = createDeferredV2Approval('open');
  const server2 = await createRealApprovalCasServer(open2, credentials);
  try {
    await runWithServerHttpBaseUrl(server2.baseUrl, async () => {
      const store = createCliApprovalsArtifactStore({ credentials, getAccountEncryptionMode: async () => 'e2ee' });
      expect(await store.approvalsGet({ artifactId: 'approval', serverId: null })).toMatchObject({ status: 'open' });
      expect(server2.counts).toEqual({ gets: 1, posts: 0, recipients: 0, other: 0 });

      // Simulate an external version bump while keeping status open: single update call recovers via one fresh retry.
      server2.bumpExternalVersion({ ...open2, updatedAtMs: 2 });

      const approved = ApprovalRequestV2Schema.parse({
        ...open2,
        status: 'approved',
        updatedAtMs: 3,
        decision: { kind: 'approve', decidedAtMs: 3 },
      });
      const recovered = await store.approvalsUpdate({ artifactId: 'approval', request: approved, serverId: null });
      expect(recovered).toEqual({ ok: true });
      expect(server2.counts).toEqual({ gets: 2, posts: 2, recipients: 0, other: 0 });
      expect(server2.readStoredRequest().status).toBe('approved');

      // Advance to executing (using cached basis from approved write -> no extra GET).
      const executing = ApprovalRequestV2Schema.parse({
        ...approved,
        status: 'executing',
        updatedAtMs: 4,
      });
      expect(await store.approvalsUpdate({ artifactId: 'approval', request: executing, serverId: null })).toEqual({ ok: true });
      expect(server2.counts).toEqual({ gets: 2, posts: 3, recipients: 0, other: 0 });

      // Worst reachable F1 case: external version bump during executing (status unchanged) must not cause outcome_unknown.
      server2.bumpExternalVersion({ ...executing, updatedAtMs: 5 });
      const executed = ApprovalRequestV2Schema.parse({
        ...executing,
        status: 'executed',
        updatedAtMs: 6,
        execution: { ok: true, result: { status: 'accepted', localId: 'local-1' }, executedAtMs: 6 },
      });
      expect(await store.approvalsUpdate({ artifactId: 'approval', request: executed, serverId: null })).toEqual({ ok: true });
      expect(server2.counts).toEqual({ gets: 3, posts: 5, recipients: 0, other: 0 });
      expect(server2.readStoredRequest().status).toBe('executed');
    });
  } finally {
    await server2.close();
  }

  // Verify the fresh retry is strictly bounded to ONE attempt and clears stale cache on a second conflict.
  const open3 = createDeferredV2Approval('open');
  const server3 = await createRealApprovalCasServer(open3, credentials);
  try {
    await runWithServerHttpBaseUrl(server3.baseUrl, async () => {
      const store = createCliApprovalsArtifactStore({ credentials, getAccountEncryptionMode: async () => 'e2ee' });
      expect(await store.approvalsGet({ artifactId: 'approval', serverId: null })).toMatchObject({ status: 'open' });
      server3.bumpExternalVersion({ ...open3, updatedAtMs: 2 });

      let postAttempt = 0;
      server3.setBeforePost(async () => {
        postAttempt += 1;
        if (postAttempt === 2) {
          // Bump again right before the single retry POST so the fresh basis also sees a real conflict.
          server3.bumpExternalVersion({ ...open3, updatedAtMs: 3 });
        }
      });

      const approved = ApprovalRequestV2Schema.parse({
        ...open3,
        status: 'approved',
        updatedAtMs: 4,
        decision: { kind: 'approve', decidedAtMs: 4 },
      });
      const doubleConflict = await store.approvalsUpdate({ artifactId: 'approval', request: approved, serverId: null });
      expect(doubleConflict).toMatchObject({ ok: false, errorCode: 'version_mismatch', writeCommitted: false });
      expect(server3.counts).toEqual({ gets: 2, posts: 2, recipients: 0, other: 0 });

      // Subsequent update has no cached basis and reads fresh cleanly.
      server3.setBeforePost(null);
      expect(await store.approvalsUpdate({ artifactId: 'approval', request: approved, serverId: null })).toEqual({ ok: true });
      expect(server3.counts).toEqual({ gets: 3, posts: 3, recipients: 0, other: 0 });
      expect(server3.readStoredRequest().status).toBe('approved');
    });
  } finally {
    await server3.close();
  }
});

it('P03 ORCH: arbitrates concurrent approved->executing claims over real HTTP CAS including the post-approve fast path', async () => {
  const credentials = createE2eeCredentials();
  const initial = createDeferredV2Approval('open');
  const server = await createRealApprovalCasServer(initial, credentials);
  try {
    await runWithServerHttpBaseUrl(server.baseUrl, async () => {
      const storeA = createCliApprovalsArtifactStore({ credentials, getAccountEncryptionMode: async () => 'e2ee' });
      const storeB = createCliApprovalsArtifactStore({ credentials, getAccountEncryptionMode: async () => 'e2ee' });
      let effectCalls = 0;
      const makeExecutor = (store: typeof storeA) => createActionExecutor({
        actionAutomations: createEmptyActionAutomationPort(),
        approvalsGet: store.approvalsGet,
        approvalsUpdate: store.approvalsUpdate,
        isApprovalExecutionOriginCurrent: async () => true,
        sessionSendMessage: async () => {
          effectCalls += 1;
          return { status: 'accepted' as const, localId: 'local-1' };
        },
      });
      const executorA = makeExecutor(storeA);
      const executorB = makeExecutor(storeB);

      let releaseA!: () => void;
      const aPausedAtClaim = new Promise<void>(resolve => { releaseA = resolve; });
      let bFinished!: Promise<unknown>;
      let interceptedA = false;

      // Intercept Executor A's fast-path approved->executing CAS POST right after open->approved
      // and run Executor B's replayApprovedApprovalRequest concurrently against the exact same
      // committed (headerVersion: 2, bodyVersion: 2) basis.
      server.setBeforePost(async ({ decodedBody, expectedHeaderVersion, expectedBodyVersion }) => {
        if (!interceptedA && decodedBody?.status === 'executing') {
          interceptedA = true;
          expect({ expectedHeaderVersion, expectedBodyVersion }).toEqual({ expectedHeaderVersion: 2, expectedBodyVersion: 2 });
          bFinished = runWithServerHttpBaseUrl(server.baseUrl, () => executorB.replayApprovedApprovalRequest({
            artifactId: 'approval',
            callerAuthority: 'present_user',
            currentAccount: { accountId: 'owner', serverId: 'home-1', serverIdentityId: 'srv-home-1' },
          }));
          await bFinished;
          releaseA();
          await aPausedAtClaim;
        }
      });

      const resultA = await executorA.execute('approval.request.decide', {
        artifactId: 'approval',
        decision: 'approve',
      }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home-1', serverIdentityId: 'srv-home-1', runtimeAccountId: 'owner' });
      const resultB = await bFinished;

      expect(interceptedA).toBe(true);
      expect(effectCalls).toBe(1);
      expect(server.readStoredRequest()).toMatchObject({ status: 'executed', execution: { ok: true } });
      expect(resultB).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
      // Executor A lost the CAS race on approved->executing, cleared its basis, re-read persisted state,
      // and observed Executor B's terminal receipt without double-executing.
      expect(resultA).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
    });
  } finally {
    await server.close();
  }

  // Also arbitrate two concurrent replayApprovedApprovalRequest claimers starting from approved.
  const approvedInitial = createDeferredV2Approval('approved');
  const server2 = await createRealApprovalCasServer(approvedInitial, credentials);
  try {
    await runWithServerHttpBaseUrl(server2.baseUrl, async () => {
      const storeA = createCliApprovalsArtifactStore({ credentials, getAccountEncryptionMode: async () => 'e2ee' });
      const storeB = createCliApprovalsArtifactStore({ credentials, getAccountEncryptionMode: async () => 'e2ee' });
      let effectCalls = 0;
      const makeExecutor = (store: typeof storeA) => createActionExecutor({
        actionAutomations: createEmptyActionAutomationPort(),
        approvalsGet: store.approvalsGet,
        approvalsUpdate: store.approvalsUpdate,
        isApprovalExecutionOriginCurrent: async () => true,
        sessionSendMessage: async () => {
          effectCalls += 1;
          return { status: 'accepted' as const, localId: 'local-1' };
        },
      });
      const executorA = makeExecutor(storeA);
      const executorB = makeExecutor(storeB);

      let claimsArrived = 0;
      let releaseBarrier!: () => void;
      const bothClaiming = new Promise<void>(resolve => { releaseBarrier = resolve; });
      server2.setBeforePost(async ({ decodedBody }) => {
        if (decodedBody?.status === 'executing') {
          claimsArrived += 1;
          if (claimsArrived === 2) releaseBarrier();
          await bothClaiming;
        }
      });

      const [resA, resB] = await Promise.all([
        executorA.replayApprovedApprovalRequest({
          artifactId: 'approval',
          callerAuthority: 'present_user',
          currentAccount: { accountId: 'owner', serverId: 'home-1', serverIdentityId: 'srv-home-1' },
        }),
        executorB.replayApprovedApprovalRequest({
          artifactId: 'approval',
          callerAuthority: 'present_user',
          currentAccount: { accountId: 'owner', serverId: 'home-1', serverIdentityId: 'srv-home-1' },
        }),
      ]);

      expect(claimsArrived).toBe(2);
      expect(effectCalls).toBe(1);
      expect(server2.readStoredRequest()).toMatchObject({ status: 'executed', execution: { ok: true } });
      const outcomes = [resA, resB];
      expect(outcomes.some(res => res.ok && (res.result as { status?: string }).status === 'executed')).toBe(true);
      // Loser either observes B's terminal receipt or reports execution_outcome_unknown while B is still executing — never double-executes.
      expect(outcomes.every(res => res.ok || res.errorCode === 'approval_execution_outcome_unknown')).toBe(true);
    });
  } finally {
    await server2.close();
  }
});
