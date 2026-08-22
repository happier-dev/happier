import { describe, it, expect, vi } from 'vitest';
import { createDeferred } from '@/testkit/async/deferred';
import { BasePermissionHandler, type PermissionResult } from './BasePermissionHandler';
import type {
  PermissionMediationRecordStore,
  PermissionMediationStoredRecord,
} from './mediation/permissionMediationRecordStore';

class FakeRpcHandlerManager {
  rawHandlers = new Map<string, (payload: any, context?: any) => any>();
  handlers = new Map<string, (payload: any, context?: any) => any>();

  constructor(private readonly sessionId: string) {}

  registerHandler(name: string, handler: any) {
    this.rawHandlers.set(name, handler);
    if (name === 'permission' || name === 'session.permission.respond') {
      this.handlers.set(name, (payload, context) => handler(
        payload,
        context ?? serverStampedPermissionContextForSession(this.sessionId),
      ));
      return;
    }
    this.handlers.set(name, handler);
  }
}

class FakeSession {
  sessionId = 'session-1';
  rpcHandlerManager = new FakeRpcHandlerManager(this.sessionId);
  agentState: any = { requests: {}, completedRequests: {} };
  boundAgentStateRequestStore: unknown = null;
  permissionResponseClaimWriteCount = 0;

  getAgentStateSnapshot() {
    return this.agentState;
  }

  updateAgentState(updater: any) {
    const nextState = updater(this.agentState);
    if (Object.values(nextState.requests ?? {}).some((request: any) => (
      request
      && typeof request === 'object'
      && Object.hasOwn(request, 'permissionResponseClaimV1')
    ))) {
      this.permissionResponseClaimWriteCount += 1;
    }
    this.agentState = nextState;
    return this.agentState;
  }

  bindAgentStateRequestStore(store: unknown) {
    this.boundAgentStateRequestStore = store;
  }

  async getAuthenticatedAccountId() {
    return 'account-owner';
  }
}

class DeferredUpdateSession extends FakeSession {
  private deferredUpdate: ReturnType<typeof createDeferred<void>> | null = null;
  private deferredUpdater: ((state: any) => any) | null = null;

  deferNextUpdate(): void {
    this.deferredUpdate = createDeferred<void>();
  }

  releaseDeferredUpdate(): void {
    const deferred = this.deferredUpdate;
    const updater = this.deferredUpdater;
    this.deferredUpdate = null;
    this.deferredUpdater = null;
    if (updater) {
      this.agentState = updater(this.agentState);
    }
    deferred?.resolve();
  }

  override updateAgentState(updater: any) {
    const deferred = this.deferredUpdate;
    if (!deferred) {
      return super.updateAgentState(updater);
    }
    this.deferredUpdater = updater;
    return deferred.promise;
  }
}

class TestPermissionHandler extends BasePermissionHandler {
  private remoteMediationAllowEligible = true;

  constructor(
    session: ConstructorParameters<typeof BasePermissionHandler>[0],
    opts?: ConstructorParameters<typeof BasePermissionHandler>[1],
  ) {
    super(session, {
      // Test fixtures model the registry's currently activated mediator unless
      // an individual case explicitly supplies a lifecycle transition.
      isMediatorPluginCurrent: () => true,
      isMediatorContributionCurrent: () => true,
      ...opts,
    });
  }

  protected getLogPrefix(): string {
    return '[Test]';
  }

  setRemoteMediationAllowEligible(eligible: boolean): void {
    this.remoteMediationAllowEligible = eligible;
    this.invalidateRemoteMediationAllowCurrentness();
  }

  protected isCurrentRemoteMediationAllowEligible(): boolean {
    return this.remoteMediationAllowEligible;
  }

  request(toolCallId: string, toolName: string, input: unknown, options?: any): Promise<PermissionResult> {
    return this.requestPermissionDecision(toolCallId, toolName, input, options);
  }

  isAllowed(toolName: string, input: unknown): boolean {
    return this.isAllowedForSession(toolName, input);
  }

  isAllowedByRemoteGrant(toolName: string, input: unknown, sourceAuthority: any): boolean {
    return this.isAllowedByRemoteMediationGrant(toolName, input, sourceAuthority);
  }

  resolveAutomatically(requestId: string, result: PermissionResult): void {
    this.resolvePendingPermissionRequest(requestId, result);
  }
}

async function settledState<T>(promise: Promise<T>): Promise<'pending' | 'fulfilled' | 'rejected'> {
  await Promise.resolve();
  await Promise.resolve();
  return Promise.race([
    promise.then(
      () => 'fulfilled' as const,
      () => 'rejected' as const,
    ),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0)),
  ]);
}

function startBlockedRemoteSettlement(params: Readonly<{
  requestId: string;
  owner?: { kind: 'plugin'; pluginId: string; runtimeId: string };
  signal?: AbortSignal;
  scope?: 'request' | 'session';
  respectAbort?: boolean;
  pauseAfterCreate?: boolean;
}>) {
  const session = new FakeSession();
  const turnId = `turn-${params.requestId}`;
  const rowCreateStarted = createDeferred<void>();
  const releaseRowCreate = createDeferred<void>();
  let stored: PermissionMediationStoredRecord | null = null;
  const recordStore: PermissionMediationRecordStore = {
    read: vi.fn(async () => (
      stored ? { status: 'found' as const, stored } : { status: 'absent' as const }
    )),
    createExpectedAbsent: vi.fn(async (input) => {
      if (params.pauseAfterCreate) {
        if (stored) return { status: 'conflict' as const };
        const created = { identity: input.identity, kind: input.kind, record: input.record, revision: `ssr1.${params.requestId}` };
        stored = created;
        rowCreateStarted.resolve();
        await releaseRowCreate.promise;
        return { status: 'created' as const, stored: created };
      }
      rowCreateStarted.resolve();
      await releaseRowCreate.promise;
      if (params.respectAbort && input.signal?.aborted) return { status: 'unavailable' as const };
      if (stored) return { status: 'conflict' as const };
      stored = { identity: input.identity, kind: input.kind, record: input.record, revision: `ssr1.${params.requestId}` };
      return { status: 'created' as const, stored };
    }),
    list: vi.fn(async () => ({
      status: 'ready' as const,
      records: stored ? [stored] : [],
      nextCursor: null,
      hasNext: false,
    })),
    pruneInactive: vi.fn(async (input) => {
      if (!stored || stored.revision !== input.expectedRevision) return { status: 'conflict' as const };
      if (stored.kind === 'remote_grant.v1' && !stored.record.revoked) return { status: 'conflict' as const };
      stored = null;
      return { status: 'pruned' as const };
    }),
    compareAndSet: vi.fn(async (input) => {
      if (!stored || stored.revision !== input.expectedRevision) return { status: 'conflict' as const };
      stored = { identity: input.identity, kind: input.kind, record: input.record, revision: `ssr1.${params.requestId}-updated` };
      return { status: 'updated' as const, stored };
    }),
  };
  const handler = new TestPermissionHandler(session as any, { mediationRecordStore: recordStore });
  const sourceAuthority = {
    kind: 'mediatedExternal',
    mediatorPluginId: 'happier.channels',
    sourceRef: 'binding:ops',
    sourceRevisionOrEpoch: '42',
    admittedPermissionCeiling: 'default',
    remoteApprovalMaxScope: params.scope === 'session' ? 'session' : 'request',
  } as const;
  const pending = handler.request(params.requestId, 'Bash', { command: ['bash', '-lc', 'echo race'] }, {
    ...(params.owner ? { owner: params.owner } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
    causalPermissionContext: {
      turnId,
      causalPermissionAuthority: {
        kind: 'admittedSessionInputV1',
        admittedPermissionCeiling: 'default',
        sourceAuthority,
      },
    },
  });
  const response = {
    sessionId: session.sessionId,
    turnId,
    requestId: params.requestId,
    sourceRef: 'binding:ops',
    sourceRevisionOrEpoch: '42',
    idempotencyKey: `${params.requestId}-retry`,
    actor: { namespace: 'discord', principalId: 'person-1' },
    decision: 'allow',
    scope: params.scope ?? 'request',
    mediator: { pluginId: 'happier.channels', contributionLocalId: 'discord' },
  } as const;
  const remote = handler.respondToMediatedPendingPermission(response);

  return {
    session,
    handler,
    recordStore,
    pending,
    remote,
    rowCreateStarted,
    releaseRowCreate,
    response,
    sourceAuthority,
    readStored: () => stored,
  };
}

function serverStampedPermissionContextForSession(sessionId: string, actor: unknown = {
  kind: 'accountUser',
  accountId: 'account-owner',
  relationship: 'owner',
}) {
  return {
    signal: new AbortController().signal,
    authorization: {
      kind: 'session.permission.respond',
      sessionId,
      actor,
    },
  };
}

function serverStampedPermissionContext(actor?: unknown) {
  return serverStampedPermissionContextForSession('session-1', actor);
}

function inactiveRemoteMediationRecord(index: number): PermissionMediationStoredRecord {
  const requestId = `retained-${String(index).padStart(4, '0')}`;
  return {
    identity: { sessionId: 'session-1', turnId: `turn-${requestId}`, requestId },
    kind: 'remote_settlement.v1',
    record: {
      version: 1,
      settlementId: `settlement-${index}`,
      turnId: `turn-${requestId}`,
      requestId,
      mediatorPluginId: 'happier.channels',
      idempotencyKey: `retention-${index}`,
      sourceAuthority: {
        kind: 'mediatedExternal',
        mediatorPluginId: 'happier.channels',
        sourceRef: 'binding:ops',
        sourceRevisionOrEpoch: '42',
        admittedPermissionCeiling: 'default',
        remoteApprovalMaxScope: 'request',
      },
      actor: {
        kind: 'externalHuman',
        assurance: 'pluginAsserted',
        namespace: 'discord',
        principalId: `person-${index}`,
        assertedBy: { pluginId: 'happier.channels', contributionLocalId: 'discord' },
      },
      decision: 'allow',
      requestedScope: 'request',
      effect: { kind: 'allowOnce' },
      createdAtMs: index,
    },
    revision: `ssr1.retained${index}`,
  };
}

function activeRemoteMediationGrant(index: number): PermissionMediationStoredRecord {
  const requestId = `active-${String(index).padStart(4, '0')}`;
  return {
    identity: { sessionId: 'session-1', turnId: `turn-${requestId}`, requestId },
    kind: 'remote_grant.v1',
    record: {
      version: 1,
      settlementId: `active-settlement-${index}`,
      turnId: `turn-${requestId}`,
      requestId,
      mediatorPluginId: 'happier.channels',
      idempotencyKey: `active-retention-${index}`,
      sourceAuthority: {
        kind: 'mediatedExternal',
        mediatorPluginId: 'happier.channels',
        sourceRef: 'binding:ops',
        sourceRevisionOrEpoch: '42',
        admittedPermissionCeiling: 'default',
        remoteApprovalMaxScope: 'session',
      },
      actor: {
        kind: 'externalHuman',
        assurance: 'pluginAsserted',
        namespace: 'discord',
        principalId: `active-person-${index}`,
        assertedBy: { pluginId: 'happier.channels', contributionLocalId: 'discord' },
      },
      decision: 'allow',
      requestedScope: 'session',
      effect: {
        kind: 'sessionGrant',
        grantId: `grant-${index}`,
        rule: { kind: 'exactTool', identifier: `Bash:${index}` },
      },
      createdAtMs: index,
    },
    revision: `ssr1.active${index}`,
  };
}

describe('BasePermissionHandler allowlist', () => {
  it('settles an automatic decision through the incumbent owner without activating a claim reservation', async () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);
    const pending = handler.request('automatic-preactivation', 'Bash', { command: ['bash', '-lc', 'echo automatic'] });

    handler.resolveAutomatically('automatic-preactivation', { decision: 'approved' });

    await expect(pending).resolves.toEqual({ decision: 'approved' });
    expect(session.permissionResponseClaimWriteCount).toBe(0);
  });

  it('persists only the causal host-stamped source authority with a mediated pending request', async () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);
    const sourceAuthority = {
      kind: 'mediatedExternal',
      mediatorPluginId: 'happier.channels',
      sourceRef: 'binding:ops',
      sourceRevisionOrEpoch: '42',
      admittedPermissionCeiling: 'default',
      remoteApprovalMaxScope: 'session',
    } as const;

    const mediated = handler.request('mediated-pending', 'Bash', { command: ['bash', '-lc', 'echo hi'] }, {
      causalPermissionContext: {
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'default',
          sourceAuthority,
        },
      },
    });
    const forged = handler.request('forged-pending', 'Bash', { command: ['bash', '-lc', 'echo hi'] }, {
      owner: {
        kind: 'plugin',
        pluginId: 'forged.plugin',
        sourceAuthority,
      },
    });

    expect(session.agentState.requests['mediated-pending']).toEqual(expect.objectContaining({
      owner: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        sourceAuthority,
      },
    }));
    expect(session.agentState.requests['forged-pending']).toEqual(expect.objectContaining({
      owner: { kind: 'plugin', pluginId: 'forged.plugin' },
    }));

    await handler.reset();
    await expect(mediated).rejects.toThrow('Session reset');
    await expect(forged).rejects.toThrow('Session reset');
  });

  it('marks a durable source-matched pending projection incomplete until compatible live waiters reattach', async () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);
    const sourceAuthority = {
      kind: 'mediatedExternal',
      mediatorPluginId: 'happier.channels',
      sourceRef: 'binding:ops',
      sourceRevisionOrEpoch: '42',
      admittedPermissionCeiling: 'default',
      remoteApprovalMaxScope: 'session',
    } as const;
    const pending = Array.from({ length: 33 }, (_, index) => handler.request(
      `remote-${String(index).padStart(2, '0')}`,
      'Bash',
      { command: ['bash', '-lc', `echo ${index}`] },
      {
        causalPermissionContext: {
          turnId: `turn-remote-${String(index).padStart(2, '0')}`,
          causalPermissionAuthority: {
            kind: 'admittedSessionInputV1',
            admittedPermissionCeiling: 'default',
            sourceAuthority,
          },
        },
      },
    ));
    const requestScopePending = handler.request('remote-request-scope', 'Bash', { command: ['bash', '-lc', 'echo request'] }, {
      causalPermissionContext: {
        turnId: 'turn-remote-request-scope',
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'default',
          sourceAuthority: {
            ...sourceAuthority,
            sourceRef: 'binding:request',
            remoteApprovalMaxScope: 'request',
          },
        },
      },
    });
    const reloadedHandler = new TestPermissionHandler(session as any);
    const listMediatedPendingRequestsMethod = (reloadedHandler as unknown as Readonly<{
      listMediatedPendingRequests: (input: Readonly<{
        mediatorPluginId: string;
        sourceRef: string;
        sourceRevisionOrEpoch: string;
      }>) => Readonly<{ requests: readonly Record<string, unknown>[]; truncated: boolean }>;
    }>).listMediatedPendingRequests;
    const listMediatedPendingRequests = (input: Readonly<{
      mediatorPluginId: string;
      sourceRef: string;
      sourceRevisionOrEpoch: string;
    }>) => listMediatedPendingRequestsMethod.call(reloadedHandler, input);
    let reattached: Promise<PermissionResult>[] = [];
    let reattachedRequestScope: Promise<PermissionResult> | null = null;

    try {
      expect(listMediatedPendingRequests({
        mediatorPluginId: 'happier.channels',
        sourceRef: 'binding:ops',
        sourceRevisionOrEpoch: '42',
      })).toEqual({ requests: [], truncated: true });
      expect(session.agentState.requests['remote-00']).toEqual(expect.objectContaining({
        turnId: 'turn-remote-00',
      }));

      reattached = Array.from({ length: 33 }, (_, index) => reloadedHandler.request(
        `remote-${String(index).padStart(2, '0')}`,
        'Bash',
        { command: ['bash', '-lc', `echo ${index}`] },
        {
          causalPermissionContext: {
            turnId: `turn-remote-${String(index).padStart(2, '0')}`,
            causalPermissionAuthority: {
              kind: 'admittedSessionInputV1',
              admittedPermissionCeiling: 'default',
              sourceAuthority,
            },
          },
        },
      ));
      reattachedRequestScope = reloadedHandler.request(
        'remote-request-scope',
        'Bash',
        { command: ['bash', '-lc', 'echo request'] },
        {
          causalPermissionContext: {
            turnId: 'turn-remote-request-scope',
            causalPermissionAuthority: {
              kind: 'admittedSessionInputV1',
              admittedPermissionCeiling: 'default',
              sourceAuthority: {
                ...sourceAuthority,
                sourceRef: 'binding:request',
                remoteApprovalMaxScope: 'request',
              },
            },
          },
        },
      );
      const result = listMediatedPendingRequests({
        mediatorPluginId: 'happier.channels',
        sourceRef: 'binding:ops',
        sourceRevisionOrEpoch: '42',
      });

      expect(result.truncated).toBe(true);
      expect(result.requests).toHaveLength(32);
      expect(result.requests[0]).toEqual({
        requestId: 'remote-00',
        turnId: 'turn-remote-00',
        createdAtMs: expect.any(Number),
        allowedScopes: ['request', 'session'],
      });
      expect(result.requests.at(-1)).toEqual({
        requestId: 'remote-31',
        turnId: 'turn-remote-31',
        createdAtMs: expect.any(Number),
        allowedScopes: ['request', 'session'],
      });
      expect(JSON.stringify(result)).not.toContain('Bash');
      expect(JSON.stringify(result)).not.toContain('echo 0');

      expect(listMediatedPendingRequests({
        mediatorPluginId: 'happier.channels',
        sourceRef: 'binding:request',
        sourceRevisionOrEpoch: '42',
      })).toEqual({
        requests: [{
          requestId: 'remote-request-scope',
          turnId: 'turn-remote-request-scope',
          createdAtMs: expect.any(Number),
          allowedScopes: ['request'],
        }],
        truncated: false,
      });
      expect(listMediatedPendingRequests({
        mediatorPluginId: 'other.plugin',
        sourceRef: 'binding:ops',
        sourceRevisionOrEpoch: '42',
      })).toEqual({ requests: [], truncated: false });
      expect(listMediatedPendingRequests({
        mediatorPluginId: 'happier.channels',
        sourceRef: 'binding:ops',
        sourceRevisionOrEpoch: '43',
      })).toEqual({ requests: [], truncated: false });
    } finally {
      await reloadedHandler.reset();
      await handler.reset();
      await Promise.allSettled([
        ...pending,
        requestScopePending,
        ...reattached,
        ...(reattachedRequestScope ? [reattachedRequestScope] : []),
      ]);
    }
  });

  it('fails closed for a mediated pending request without an exact host turn identity', async () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);
    const pending = handler.request('remote-no-turn', 'Bash', { command: ['bash', '-lc', 'echo no-turn'] }, {
      causalPermissionContext: {
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'default',
          sourceAuthority: {
            kind: 'mediatedExternal',
            mediatorPluginId: 'happier.channels',
            sourceRef: 'binding:ops',
            sourceRevisionOrEpoch: '42',
            admittedPermissionCeiling: 'default',
            remoteApprovalMaxScope: 'request',
          },
        },
      },
    });

    try {
      expect(handler.listMediatedPendingRequests({
        mediatorPluginId: 'happier.channels',
        sourceRef: 'binding:ops',
        sourceRevisionOrEpoch: '42',
      })).toEqual({ requests: [], truncated: false });
    } finally {
      await handler.reset();
      await expect(pending).rejects.toThrow('Session reset');
    }
  });

  it('keeps the persisted turn and ordering metadata when a fresh handler reattaches a mediated waiter', async () => {
    const session = new FakeSession();
    const sourceAuthority = {
      kind: 'mediatedExternal',
      mediatorPluginId: 'happier.channels',
      sourceRef: 'binding:ops',
      sourceRevisionOrEpoch: '42',
      admittedPermissionCeiling: 'default',
      remoteApprovalMaxScope: 'request',
    } as const;
    session.agentState.requests['remote-persisted-turn'] = {
      tool: 'Bash',
      kind: 'permission',
      arguments: { command: ['bash', '-lc', 'echo persisted'] },
      createdAt: 100,
      source: 'remote-mediation',
      owner: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        sourceAuthority,
      },
      turnId: 'turn-persisted',
    };
    const handler = new TestPermissionHandler(session as any);
    const pending = handler.request('remote-persisted-turn', 'Bash', { command: ['bash', '-lc', 'echo persisted'] }, {
      source: 'remote-mediation',
      causalPermissionContext: {
        turnId: 'turn-persisted',
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'default',
          sourceAuthority,
        },
      },
    });

    try {
      expect(await settledState(pending)).toBe('pending');
      expect(handler.listMediatedPendingRequests({
        mediatorPluginId: 'happier.channels',
        sourceRef: 'binding:ops',
        sourceRevisionOrEpoch: '42',
      })).toEqual({
        requests: [{
          requestId: 'remote-persisted-turn',
          turnId: 'turn-persisted',
          createdAtMs: 100,
          allowedScopes: ['request'],
        }],
        truncated: false,
      });
      expect(session.agentState.requests['remote-persisted-turn']).toEqual(expect.objectContaining({
        createdAt: 100,
        turnId: 'turn-persisted',
      }));
    } finally {
      await handler.reset();
      await expect(pending).rejects.toThrow('Session reset');
    }
  });

  it('orders tied mediated pending requests by persisted turn before request id', async () => {
    const session = new FakeSession();
    const sourceAuthority = {
      kind: 'mediatedExternal',
      mediatorPluginId: 'happier.channels',
      sourceRef: 'binding:ops',
      sourceRevisionOrEpoch: '42',
      admittedPermissionCeiling: 'default',
      remoteApprovalMaxScope: 'request',
    } as const;
    const owner = {
      kind: 'plugin' as const,
      pluginId: 'happier.channels',
      sourceAuthority,
    };
    session.agentState.requests['a-request'] = {
      tool: 'Bash',
      kind: 'permission',
      arguments: { command: ['bash', '-lc', 'echo first'] },
      createdAt: 100,
      source: 'remote-mediation',
      owner,
      turnId: 'turn-z',
    };
    session.agentState.requests['z-request'] = {
      tool: 'Bash',
      kind: 'permission',
      arguments: { command: ['bash', '-lc', 'echo second'] },
      createdAt: 100,
      source: 'remote-mediation',
      owner,
      turnId: 'turn-a',
    };
    const handler = new TestPermissionHandler(session as any);
    const first = handler.request('a-request', 'Bash', { command: ['bash', '-lc', 'echo first'] }, {
      source: 'remote-mediation',
      causalPermissionContext: {
        turnId: 'turn-z',
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'default',
          sourceAuthority,
        },
      },
    });
    const second = handler.request('z-request', 'Bash', { command: ['bash', '-lc', 'echo second'] }, {
      source: 'remote-mediation',
      causalPermissionContext: {
        turnId: 'turn-a',
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'default',
          sourceAuthority,
        },
      },
    });

    try {
      expect(handler.listMediatedPendingRequests({
        mediatorPluginId: 'happier.channels',
        sourceRef: 'binding:ops',
        sourceRevisionOrEpoch: '42',
      }).requests.map(({ requestId, turnId }) => ({ requestId, turnId }))).toEqual([
        { requestId: 'z-request', turnId: 'turn-a' },
        { requestId: 'a-request', turnId: 'turn-z' },
      ]);
    } finally {
      await handler.reset();
      await Promise.allSettled([first, second]);
    }
  });

  it('requires the exact persisted turn before a remote response can claim or write a settlement', async () => {
    const session = new FakeSession();
    let stored: PermissionMediationStoredRecord | null = null;
    const recordStore: PermissionMediationRecordStore = {
      read: vi.fn(async () => (
        stored ? { status: 'found' as const, stored } : { status: 'absent' as const }
      )),
      createExpectedAbsent: vi.fn(async (input) => {
        if (stored) return { status: 'conflict' as const };
        stored = { identity: input.identity, kind: input.kind, record: input.record, revision: 'ssr1.turn-custody' };
        return { status: 'created' as const, stored };
      }),
      list: vi.fn(async () => ({ status: 'ready' as const, records: [], nextCursor: null, hasNext: false })),
      pruneInactive: vi.fn(async () => ({ status: 'unavailable' as const })),
      compareAndSet: vi.fn(async () => ({ status: 'unavailable' as const })),
    };
    const handler = new TestPermissionHandler(session as any, { mediationRecordStore: recordStore });
    const sourceAuthority = {
      kind: 'mediatedExternal',
      mediatorPluginId: 'happier.channels',
      sourceRef: 'binding:ops',
      sourceRevisionOrEpoch: '42',
      admittedPermissionCeiling: 'default',
      remoteApprovalMaxScope: 'request',
    } as const;
    const pending = handler.request('response-turn-custody', 'Bash', { command: ['bash', '-lc', 'echo custody'] }, {
      causalPermissionContext: {
        turnId: 'turn-a',
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'default',
          sourceAuthority,
        },
      },
    });
    const response = {
      sessionId: session.sessionId,
      requestId: 'response-turn-custody',
      turnId: 'turn-a',
      sourceRef: 'binding:ops',
      sourceRevisionOrEpoch: '42',
      idempotencyKey: 'turn-custody-retry',
      actor: { namespace: 'discord', principalId: 'person-1' },
      decision: 'allow' as const,
      scope: 'request' as const,
      mediator: { pluginId: 'happier.channels', contributionLocalId: 'discord' },
    };

    try {
      await expect(handler.respondToMediatedPendingPermission({
        ...response,
        turnId: 'turn-b',
      } as never)).resolves.toEqual({ status: 'rejected', code: 'requestNotFound' });
      expect(session.permissionResponseClaimWriteCount).toBe(0);
      expect(recordStore.createExpectedAbsent).not.toHaveBeenCalled();
      expect(await settledState(pending)).toBe('pending');

      await expect(handler.respondToMediatedPendingPermission({
        ...response,
        sessionId: 'other-session',
      } as never)).resolves.toEqual({ status: 'rejected', code: 'requestNotFound' });
      expect(session.permissionResponseClaimWriteCount).toBe(0);
      expect(recordStore.createExpectedAbsent).not.toHaveBeenCalled();
      expect(await settledState(pending)).toBe('pending');

      const exact = handler.respondToMediatedPendingPermission(response as never);
      expect(session.agentState.requests['response-turn-custody']).toEqual(expect.objectContaining({
        turnId: 'turn-a',
        permissionResponseClaimV1: expect.objectContaining({
          origin: 'remoteMediation',
          turnId: 'turn-a',
        }),
      }));
      await expect(exact).resolves.toEqual(expect.objectContaining({
        status: 'applied',
        requestId: 'response-turn-custody',
      }));
      await expect(pending).resolves.toEqual({ decision: 'approved' });
    } finally {
      await handler.reset();
      await Promise.allSettled([pending]);
    }
  });

  it('keeps sequential request-id reuse independent across restart, including a different idempotency key', async () => {
    const session = new FakeSession();
    const storedByTransportIdentity = new Map<string, PermissionMediationStoredRecord>();
    const transportKey = (input: unknown): string => {
      const value = input && typeof input === 'object' ? input as Record<string, unknown> : {};
      const identity = value.identity && typeof value.identity === 'object'
        ? value.identity as Record<string, unknown>
        : null;
      const turnId = typeof identity?.turnId === 'string' ? identity.turnId : 'missing-turn';
      const requestId = typeof identity?.requestId === 'string'
        ? identity.requestId
        : typeof value.requestId === 'string' ? value.requestId : 'missing-request';
      return `${turnId}\u0000${requestId}`;
    };
    // This is the real system-record boundary shape under migration. The
    // pre-fix caller omits `identity.turnId`, which intentionally reproduces
    // the old requestId-only durable address.
    const recordStore = {
      read: vi.fn(async (input: unknown) => {
        const stored = storedByTransportIdentity.get(transportKey(input));
        return stored ? { status: 'found' as const, stored } : { status: 'absent' as const };
      }),
      createExpectedAbsent: vi.fn(async (input: unknown) => {
        const key = transportKey(input);
        if (storedByTransportIdentity.has(key)) return { status: 'conflict' as const };
        const write = input as Parameters<PermissionMediationRecordStore['createExpectedAbsent']>[0];
        const stored = {
          identity: write.identity,
          kind: write.kind,
          record: write.record,
          revision: `ssr1.${storedByTransportIdentity.size + 1}`,
        } as PermissionMediationStoredRecord;
        storedByTransportIdentity.set(key, stored);
        return { status: 'created' as const, stored };
      }),
      list: vi.fn(async () => ({
        status: 'ready' as const,
        records: [...storedByTransportIdentity.values()],
        nextCursor: null,
        hasNext: false,
      })),
      pruneInactive: vi.fn(async () => ({ status: 'unavailable' as const })),
      compareAndSet: vi.fn(async () => ({ status: 'unavailable' as const })),
    } satisfies PermissionMediationRecordStore;
    const sourceAuthority = {
      kind: 'mediatedExternal',
      mediatorPluginId: 'happier.channels',
      sourceRef: 'binding:ops',
      sourceRevisionOrEpoch: '42',
      admittedPermissionCeiling: 'default',
      remoteApprovalMaxScope: 'request',
    } as const;
    const requestId = 'sequential-reuse';
    const firstHandler = new TestPermissionHandler(session as any, { mediationRecordStore: recordStore });
    let restartedHandler: TestPermissionHandler | null = null;
    let secondHandler: TestPermissionHandler | null = null;
    const makeResponse = (turnId: string, idempotencyKey = 'same-retry-key') => ({
      sessionId: session.sessionId,
      turnId,
      requestId,
      sourceRef: sourceAuthority.sourceRef,
      sourceRevisionOrEpoch: sourceAuthority.sourceRevisionOrEpoch,
      idempotencyKey,
      actor: { namespace: 'discord', principalId: 'person-1' },
      decision: 'allow' as const,
      scope: 'request' as const,
      mediator: { pluginId: 'happier.channels', contributionLocalId: 'discord' },
    });

    const firstPending = firstHandler.request(requestId, 'Bash', { command: ['bash', '-lc', 'echo first'] }, {
      causalPermissionContext: {
        turnId: 'turn-first',
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'default',
          sourceAuthority,
        },
      },
    });
    try {
      await expect(firstHandler.respondToMediatedPendingPermission(makeResponse('turn-first'))).resolves.toEqual(expect.objectContaining({
        status: 'applied',
        requestId,
      }));
      await expect(firstPending).resolves.toEqual({ decision: 'approved' });

      restartedHandler = new TestPermissionHandler(session as any, { mediationRecordStore: recordStore });
      await expect(restartedHandler.respondToMediatedPendingPermission(makeResponse('turn-first'))).resolves.toEqual(expect.objectContaining({
        status: 'alreadyApplied',
        requestId,
      }));

      delete session.agentState.completedRequests[requestId];
      secondHandler = new TestPermissionHandler(session as any, { mediationRecordStore: recordStore });
      const secondPending = secondHandler.request(requestId, 'Bash', { command: ['bash', '-lc', 'echo second'] }, {
        causalPermissionContext: {
          turnId: 'turn-second',
          causalPermissionAuthority: {
            kind: 'admittedSessionInputV1',
            admittedPermissionCeiling: 'default',
            sourceAuthority,
          },
        },
      });
      await expect(secondHandler.respondToMediatedPendingPermission(makeResponse('turn-second', 'different-turn-key'))).resolves.toEqual(expect.objectContaining({
        status: 'applied',
        requestId,
      }));
      await expect(secondPending).resolves.toEqual({ decision: 'approved' });
      expect(storedByTransportIdentity.size).toBe(2);
    } finally {
      await secondHandler?.reset();
      await restartedHandler?.reset();
      await firstHandler.reset();
      await Promise.allSettled([firstPending]);
    }
  });

  it('fails remote mediation closed when the active owner has no host-only record port', async () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);
    const pending = handler.request('remote-no-port', 'Bash', { command: ['bash', '-lc', 'echo no-port'] }, {
      causalPermissionContext: {
        turnId: 'turn-remote-no-port',
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'default',
          sourceAuthority: {
            kind: 'mediatedExternal',
            mediatorPluginId: 'happier.channels',
            sourceRef: 'binding:ops',
            sourceRevisionOrEpoch: '42',
            admittedPermissionCeiling: 'default',
            remoteApprovalMaxScope: 'request',
          },
        },
      },
    });

    await expect(handler.respondToMediatedPendingPermission({
      sessionId: session.sessionId,
      turnId: 'turn-remote-no-port',
      requestId: 'remote-no-port',
      sourceRef: 'binding:ops',
      sourceRevisionOrEpoch: '42',
      idempotencyKey: 'retry-1',
      actor: { namespace: 'discord', principalId: 'person-1' },
      decision: 'allow',
      scope: 'request',
      mediator: { pluginId: 'happier.channels', contributionLocalId: 'discord' },
    })).resolves.toEqual({ status: 'rejected', code: 'mediationStateUnavailable' });
    expect(session.agentState.requests['remote-no-port']).toBeDefined();
    expect(session.agentState.completedRequests['remote-no-port']).toBeUndefined();
    expect(await settledState(pending)).toBe('pending');

    await handler.reset();
    await expect(pending).rejects.toThrow('Session reset');
  });

  it('omits remote requests whose existing request id cannot address the host mediation ledger', async () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);
    const requestId = 'remote\u0001ineligible';
    const pending = handler.request(requestId, 'Bash', { command: ['bash', '-lc', 'echo invalid-id'] }, {
      causalPermissionContext: {
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'default',
          sourceAuthority: {
            kind: 'mediatedExternal',
            mediatorPluginId: 'happier.channels',
            sourceRef: 'binding:ops',
            sourceRevisionOrEpoch: '42',
            admittedPermissionCeiling: 'default',
            remoteApprovalMaxScope: 'request',
          },
        },
      },
    });

    try {
      expect(handler.listMediatedPendingRequests({
        mediatorPluginId: 'happier.channels',
        sourceRef: 'binding:ops',
        sourceRevisionOrEpoch: '42',
      })).toEqual({ requests: [], truncated: false });
      await expect(handler.respondToMediatedPendingPermission({
        sessionId: session.sessionId,
        turnId: `turn-${requestId}`,
        requestId,
        sourceRef: 'binding:ops',
        sourceRevisionOrEpoch: '42',
        idempotencyKey: 'retry-1',
        actor: { namespace: 'discord', principalId: 'person-1' },
        decision: 'allow',
        scope: 'request',
        mediator: { pluginId: 'happier.channels', contributionLocalId: 'discord' },
      })).resolves.toEqual({ status: 'rejected', code: 'requestNotFound' });
      expect(session.agentState.requests[requestId]).toBeDefined();
      expect(session.agentState.completedRequests[requestId]).toBeUndefined();
      expect(await settledState(pending)).toBe('pending');
    } finally {
      await handler.reset();
      await expect(pending).rejects.toThrow('Session reset');
    }
  });

  it('settles one source-matched remote request through the typed mediation record claim without seeding the legacy allowlist', async () => {
    const session = new FakeSession();
    let stored: PermissionMediationStoredRecord | null = null;
    const recordStore: PermissionMediationRecordStore = {
      read: vi.fn(async () => (
        stored ? { status: 'found' as const, stored } : { status: 'absent' as const }
      )),
      createExpectedAbsent: vi.fn(async (input) => {
        if (stored) return { status: 'conflict' as const };
        stored = { identity: input.identity, kind: input.kind, record: input.record, revision: 'ssr1.AAAACHNldHRsZW1lbnQtMQAAAAE' };
        return { status: 'created' as const, stored };
      }),
      list: vi.fn(async () => ({ status: 'ready' as const, records: [], nextCursor: null, hasNext: false })),
      pruneInactive: vi.fn(async () => ({ status: 'unavailable' as const })),
      compareAndSet: vi.fn(async () => ({ status: 'unavailable' as const })),
    };
    const handler = new TestPermissionHandler(session as any, {
      mediationRecordStore: recordStore,
    });
    const sourceAuthority = {
      kind: 'mediatedExternal',
      mediatorPluginId: 'happier.channels',
      sourceRef: 'binding:ops',
      sourceRevisionOrEpoch: '42',
      admittedPermissionCeiling: 'default',
      remoteApprovalMaxScope: 'request',
    } as const;
    const requestInput = { command: ['bash', '-lc', 'echo remote'] };
    const pending = handler.request('remote-settlement', 'Bash', requestInput, {
      causalPermissionContext: {
        turnId: 'turn-remote-settlement',
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'default',
          sourceAuthority,
        },
      },
    });
    const input = {
      sessionId: session.sessionId,
      turnId: 'turn-remote-settlement',
      requestId: 'remote-settlement',
      sourceRef: 'binding:ops',
      sourceRevisionOrEpoch: '42',
      idempotencyKey: 'retry-1',
      actor: { namespace: 'discord', principalId: 'person-1' },
      decision: 'allow' as const,
      scope: 'request' as const,
      mediator: { pluginId: 'happier.channels', contributionLocalId: 'discord' },
    };
    await expect(handler.respondToMediatedPendingPermission(input)).resolves.toEqual(expect.objectContaining({
      status: 'applied',
      requestId: 'remote-settlement',
      decision: 'allow',
      effect: { kind: 'allowOnce' },
      settlementId: expect.any(String),
    }));
    await expect(pending).resolves.toEqual({ decision: 'approved' });
    expect(recordStore.createExpectedAbsent).toHaveBeenCalledWith(expect.objectContaining({
      identity: {
        sessionId: session.sessionId,
        turnId: 'turn-remote-settlement',
        requestId: 'remote-settlement',
      },
      kind: 'remote_settlement.v1',
      record: expect.objectContaining({
        actor: {
          kind: 'externalHuman',
          assurance: 'pluginAsserted',
          namespace: 'discord',
          principalId: 'person-1',
          assertedBy: { pluginId: 'happier.channels', contributionLocalId: 'discord' },
        },
      }),
    }));
    expect(session.agentState.completedRequests['remote-settlement']).toEqual(expect.objectContaining({
      remoteMediationSettlementId: expect.any(String),
    }));
    expect(JSON.stringify(session.agentState.completedRequests['remote-settlement'])).not.toContain('person-1');
    expect(handler.isAllowed('Bash', requestInput)).toBe(false);

    await expect(handler.respondToMediatedPendingPermission(input)).resolves.toEqual(expect.objectContaining({
      status: 'alreadyApplied',
      requestId: 'remote-settlement',
      decision: 'allow',
      effect: { kind: 'allowOnce' },
    }));
    await expect(handler.respondToMediatedPendingPermission({
      ...input,
      actor: { namespace: 'discord', principalId: 'another-person' },
    })).resolves.toEqual({ status: 'rejected', code: 'decisionConflict' });
  });

  it('keeps a remote first answer ahead of a present response from a fresh handler before the mediation row commits', async () => {
    const session = new FakeSession();
    const rowCreateStarted = createDeferred<void>();
    const releaseRowCreate = createDeferred<void>();
    let stored: PermissionMediationStoredRecord | null = null;
    const recordStore: PermissionMediationRecordStore = {
      read: vi.fn(async () => (
        stored ? { status: 'found' as const, stored } : { status: 'absent' as const }
      )),
      createExpectedAbsent: vi.fn(async (input) => {
        rowCreateStarted.resolve();
        await releaseRowCreate.promise;
        if (stored) return { status: 'conflict' as const };
        stored = { identity: input.identity, kind: input.kind, record: input.record, revision: 'ssr1.remote-first-answer' };
        return { status: 'created' as const, stored };
      }),
      list: vi.fn(async () => ({ status: 'ready' as const, records: [], nextCursor: null, hasNext: false })),
      pruneInactive: vi.fn(async () => ({ status: 'unavailable' as const })),
      compareAndSet: vi.fn(async () => ({ status: 'unavailable' as const })),
    };
    const handler = new TestPermissionHandler(session as any, { mediationRecordStore: recordStore });
    const sourceAuthority = {
      kind: 'mediatedExternal',
      mediatorPluginId: 'happier.channels',
      sourceRef: 'binding:ops',
      sourceRevisionOrEpoch: '42',
      admittedPermissionCeiling: 'default',
      remoteApprovalMaxScope: 'request',
    } as const;
    const pending = handler.request('remote-first-answer', 'Bash', { command: ['bash', '-lc', 'echo race'] }, {
      causalPermissionContext: {
        turnId: 'turn-remote-first-answer',
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'default',
          sourceAuthority,
        },
      },
    });
    const remote = handler.respondToMediatedPendingPermission({
      sessionId: session.sessionId,
      turnId: 'turn-remote-first-answer',
      requestId: 'remote-first-answer',
      sourceRef: 'binding:ops',
      sourceRevisionOrEpoch: '42',
      idempotencyKey: 'remote-first-answer-retry',
      actor: { namespace: 'discord', principalId: 'person-1' },
      decision: 'allow',
      scope: 'request',
      mediator: { pluginId: 'happier.channels', contributionLocalId: 'discord' },
    });
    let reloadedHandler: TestPermissionHandler | null = null;

    try {
      await rowCreateStarted.promise;
      reloadedHandler = new TestPermissionHandler(session as any, { mediationRecordStore: recordStore });
      const present = session.rpcHandlerManager.handlers.get('session.permission.respond');
      expect(present).toBeDefined();

      await expect(present!({
        id: 'remote-first-answer',
        approved: false,
        decision: 'denied',
      })).resolves.toEqual({
        ok: false,
        errorCode: 'permission_request_not_found',
        requestId: 'remote-first-answer',
      });
      expect(session.agentState.requests['remote-first-answer']).toBeDefined();
      expect(session.agentState.completedRequests['remote-first-answer']).toBeUndefined();

      releaseRowCreate.resolve();
      await expect(remote).resolves.toEqual(expect.objectContaining({
        status: 'applied',
        decision: 'allow',
        effect: { kind: 'allowOnce' },
      }));
      await expect(pending).resolves.toEqual({ decision: 'approved' });
      expect(stored).toEqual(expect.objectContaining({ kind: 'remote_settlement.v1' }));
      expect(session.agentState.completedRequests['remote-first-answer']).toEqual(expect.objectContaining({
        remoteMediationSettlementId: expect.any(String),
        decision: 'approved',
      }));
    } finally {
      releaseRowCreate.resolve();
      await Promise.allSettled([remote, pending]);
      await handler.reset();
      await reloadedHandler?.reset();
    }
  });

  it('does not let an automatic terminal path overtake a claimed remote settlement before its row commits', async () => {
    const session = new FakeSession();
    const rowCreateStarted = createDeferred<void>();
    const releaseRowCreate = createDeferred<void>();
    let stored: PermissionMediationStoredRecord | null = null;
    const recordStore: PermissionMediationRecordStore = {
      read: vi.fn(async () => (
        stored ? { status: 'found' as const, stored } : { status: 'absent' as const }
      )),
      createExpectedAbsent: vi.fn(async (input) => {
        rowCreateStarted.resolve();
        await releaseRowCreate.promise;
        if (stored) return { status: 'conflict' as const };
        stored = { identity: input.identity, kind: input.kind, record: input.record, revision: 'ssr1.remote-automatic-race' };
        return { status: 'created' as const, stored };
      }),
      list: vi.fn(async () => ({ status: 'ready' as const, records: [], nextCursor: null, hasNext: false })),
      pruneInactive: vi.fn(async () => ({ status: 'unavailable' as const })),
      compareAndSet: vi.fn(async () => ({ status: 'unavailable' as const })),
    };
    const handler = new TestPermissionHandler(session as any, { mediationRecordStore: recordStore });
    const sourceAuthority = {
      kind: 'mediatedExternal',
      mediatorPluginId: 'happier.channels',
      sourceRef: 'binding:ops',
      sourceRevisionOrEpoch: '42',
      admittedPermissionCeiling: 'default',
      remoteApprovalMaxScope: 'request',
    } as const;
    const pending = handler.request('remote-automatic-race', 'Bash', { command: ['bash', '-lc', 'echo race'] }, {
      causalPermissionContext: {
        turnId: 'turn-remote-automatic-race',
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'default',
          sourceAuthority,
        },
      },
    });
    const remote = handler.respondToMediatedPendingPermission({
      sessionId: session.sessionId,
      turnId: 'turn-remote-automatic-race',
      requestId: 'remote-automatic-race',
      sourceRef: 'binding:ops',
      sourceRevisionOrEpoch: '42',
      idempotencyKey: 'remote-automatic-race-retry',
      actor: { namespace: 'discord', principalId: 'person-1' },
      decision: 'allow',
      scope: 'request',
      mediator: { pluginId: 'happier.channels', contributionLocalId: 'discord' },
    });

    try {
      await rowCreateStarted.promise;
      handler.resolveAutomatically('remote-automatic-race', { decision: 'denied' });

      expect(await settledState(pending)).toBe('pending');
      expect(session.agentState.requests['remote-automatic-race']).toBeDefined();
      expect(session.agentState.completedRequests['remote-automatic-race']).toBeUndefined();

      releaseRowCreate.resolve();
      await expect(remote).resolves.toEqual(expect.objectContaining({
        status: 'applied',
        decision: 'allow',
        effect: { kind: 'allowOnce' },
      }));
      await expect(pending).resolves.toEqual({ decision: 'approved' });
      expect(stored).toEqual(expect.objectContaining({ kind: 'remote_settlement.v1' }));
    } finally {
      releaseRowCreate.resolve();
      await Promise.allSettled([remote, pending]);
      await handler.reset();
    }
  });

  it('keeps a claimed remote settlement current when cancelAll runs during its blocked row CAS', async () => {
    const race = startBlockedRemoteSettlement({ requestId: 'remote-cancel-all-race' });

    try {
      await race.rowCreateStarted.promise;
      await expect(race.handler.reset()).resolves.toBeUndefined();

      expect(await settledState(race.pending)).toBe('pending');
      expect(race.session.agentState.requests['remote-cancel-all-race']).toBeDefined();
      expect(race.session.agentState.completedRequests['remote-cancel-all-race']).toBeUndefined();

      race.releaseRowCreate.resolve();
      await expect(race.remote).resolves.toEqual(expect.objectContaining({
        status: 'applied',
        requestId: 'remote-cancel-all-race',
        decision: 'allow',
        effect: { kind: 'allowOnce' },
      }));
      await expect(race.pending).resolves.toEqual({ decision: 'approved' });
      expect(race.readStored()).toEqual(expect.objectContaining({ kind: 'remote_settlement.v1' }));
      expect(race.session.agentState.completedRequests['remote-cancel-all-race']).toEqual(expect.objectContaining({
        status: 'approved',
        decision: 'approved',
        remoteMediationSettlementId: expect.any(String),
      }));
    } finally {
      race.releaseRowCreate.resolve();
      await race.handler.reset();
      await Promise.allSettled([race.remote, race.pending]);
    }
  });

  it('keeps a claimed remote settlement current when cancelByPlugin runs during its blocked row CAS', async () => {
    const race = startBlockedRemoteSettlement({
      requestId: 'remote-cancel-plugin-race',
      owner: { kind: 'plugin', pluginId: 'happier.channels', runtimeId: 'channels-runtime' },
    });

    try {
      await race.rowCreateStarted.promise;
      await expect(race.handler.cancelByPlugin('happier.channels', 'plugin_deactivated')).resolves.toBeUndefined();

      expect(await settledState(race.pending)).toBe('pending');
      expect(race.session.agentState.requests['remote-cancel-plugin-race']).toBeDefined();
      expect(race.session.agentState.completedRequests['remote-cancel-plugin-race']).toBeUndefined();

      race.releaseRowCreate.resolve();
      await expect(race.remote).resolves.toEqual(expect.objectContaining({
        status: 'applied',
        requestId: 'remote-cancel-plugin-race',
        decision: 'allow',
        effect: { kind: 'allowOnce' },
      }));
      await expect(race.pending).resolves.toEqual({ decision: 'approved' });
      expect(race.readStored()).toEqual(expect.objectContaining({ kind: 'remote_settlement.v1' }));
      expect(race.session.agentState.completedRequests['remote-cancel-plugin-race']).toEqual(expect.objectContaining({
        status: 'approved',
        decision: 'approved',
        remoteMediationSettlementId: expect.any(String),
      }));
    } finally {
      race.releaseRowCreate.resolve();
      await Promise.allSettled([race.remote, race.pending]);
      await race.handler.reset();
    }
  });

  it('does not terminalize a claimed plugin-owned request when its last waiter aborts during its blocked row CAS', async () => {
    const abort = new AbortController();
    const race = startBlockedRemoteSettlement({
      requestId: 'remote-last-waiter-race',
      owner: { kind: 'plugin', pluginId: 'happier.channels', runtimeId: 'channels-runtime' },
      signal: abort.signal,
    });

    try {
      await race.rowCreateStarted.promise;
      abort.abort();
      await expect(race.pending).rejects.toThrow('Permission request aborted');

      expect(race.session.agentState.requests['remote-last-waiter-race']).toBeDefined();
      expect(race.session.agentState.completedRequests['remote-last-waiter-race']).toBeUndefined();

      race.releaseRowCreate.resolve();
      await expect(race.remote).resolves.toEqual(expect.objectContaining({
        status: 'applied',
        requestId: 'remote-last-waiter-race',
        decision: 'allow',
        effect: { kind: 'allowOnce' },
      }));
      expect(race.readStored()).toEqual(expect.objectContaining({ kind: 'remote_settlement.v1' }));
      expect(race.session.agentState.completedRequests['remote-last-waiter-race']).toEqual(expect.objectContaining({
        status: 'approved',
        decision: 'approved',
        remoteMediationSettlementId: expect.any(String),
      }));
    } finally {
      race.releaseRowCreate.resolve();
      await Promise.allSettled([race.remote, race.pending]);
      await race.handler.reset();
    }
  });

  it('does not commit a remote session grant when current policy narrows during its blocked row CAS', async () => {
    const race = startBlockedRemoteSettlement({
      requestId: 'remote-policy-narrowed-during-cas',
      scope: 'session',
      respectAbort: true,
    });

    try {
      await race.rowCreateStarted.promise;
      race.handler.setRemoteMediationAllowEligible(false);
      race.releaseRowCreate.resolve();

      await expect(race.remote).resolves.toEqual({
        status: 'rejected',
        code: 'permissionCeilingExceeded',
      });
      expect(race.readStored()).toBeNull();
      expect(race.session.agentState.requests['remote-policy-narrowed-during-cas']).toBeDefined();
      expect(race.session.agentState.completedRequests['remote-policy-narrowed-during-cas']).toBeUndefined();
      expect(await settledState(race.pending)).toBe('pending');
    } finally {
      race.releaseRowCreate.resolve();
      await race.handler.reset();
      await Promise.allSettled([race.remote, race.pending]);
    }
  });

  it('neutralizes a created stale remote session grant before an exact retry or restart can replay it', async () => {
    const race = startBlockedRemoteSettlement({
      requestId: 'remote-policy-narrowed-ignored-cas',
      scope: 'session',
      respectAbort: false,
    });
    const input = { command: ['bash', '-lc', 'echo race'] };
    let recovered: TestPermissionHandler | null = null;

    try {
      await race.rowCreateStarted.promise;
      race.handler.setRemoteMediationAllowEligible(false);
      race.releaseRowCreate.resolve();

      await expect(race.remote).resolves.toEqual({
        status: 'rejected',
        code: 'permissionCeilingExceeded',
      });
      expect(race.readStored()).toEqual(expect.objectContaining({
        kind: 'remote_grant.v1',
        record: expect.objectContaining({
          revoked: expect.objectContaining({
            actor: { kind: 'accountUser', accountId: 'account-owner' },
          }),
        }),
      }));
      expect(race.handler.isAllowedByRemoteGrant('Bash', input, race.sourceAuthority)).toBe(false);

      race.handler.setRemoteMediationAllowEligible(true);
      const incumbentRetry = await race.handler.respondToMediatedPendingPermission(race.response);
      expect(incumbentRetry).toEqual({
        status: 'rejected',
        code: 'requestNotPending',
      });
      expect(race.handler.isAllowedByRemoteGrant('Bash', input, race.sourceAuthority)).toBe(false);

      recovered = new TestPermissionHandler(race.session as any, { mediationRecordStore: race.recordStore });
      await Promise.resolve();
      await Promise.resolve();
      expect(recovered.isAllowedByRemoteGrant('Bash', input, race.sourceAuthority)).toBe(false);
      const claimWritesBeforeRecoveryRetry = race.session.permissionResponseClaimWriteCount;
      const recoveredRetry = await recovered.respondToMediatedPendingPermission(race.response);
      expect(recoveredRetry).toEqual({
        status: 'rejected',
        code: 'requestNotPending',
      });
      expect(race.session.permissionResponseClaimWriteCount).toBe(claimWritesBeforeRecoveryRetry);
    } finally {
      race.releaseRowCreate.resolve();
      await recovered?.reset();
      await race.handler.reset();
      await Promise.allSettled([race.remote, race.pending]);
    }
  });

  it('settles a pruned stale remote allow non-authorizing and keeps it non-replayable', async () => {
    const race = startBlockedRemoteSettlement({
      requestId: 'remote-policy-narrowed-pruned-settlement',
      scope: 'request',
      respectAbort: false,
    });
    let recovered: TestPermissionHandler | null = null;

    try {
      await race.rowCreateStarted.promise;
      race.handler.setRemoteMediationAllowEligible(false);
      race.releaseRowCreate.resolve();

      await expect(race.remote).resolves.toEqual({
        status: 'rejected',
        code: 'permissionCeilingExceeded',
      });
      expect(race.readStored()).toBeNull();
      expect(race.recordStore.pruneInactive).toHaveBeenCalledWith(expect.objectContaining({
        identity: {
          sessionId: race.session.sessionId,
          turnId: 'turn-remote-policy-narrowed-pruned-settlement',
          requestId: 'remote-policy-narrowed-pruned-settlement',
        },
      }));
      expect(race.session.agentState.requests['remote-policy-narrowed-pruned-settlement']).toBeUndefined();
      expect(race.session.agentState.completedRequests['remote-policy-narrowed-pruned-settlement']).toEqual(
        expect.objectContaining({
          status: 'denied',
          decision: 'denied',
          remoteMediationSettlementId: expect.any(String),
        }),
      );
      await expect(race.pending).resolves.toEqual({ decision: 'denied' });

      race.handler.setRemoteMediationAllowEligible(true);
      await expect(race.handler.respondToMediatedPendingPermission(race.response)).resolves.toEqual({
        status: 'rejected',
        code: 'requestNotPending',
      });

      recovered = new TestPermissionHandler(race.session as any, { mediationRecordStore: race.recordStore });
      await expect(recovered.respondToMediatedPendingPermission(race.response)).resolves.toEqual({
        status: 'rejected',
        code: 'requestNotPending',
      });
    } finally {
      race.releaseRowCreate.resolve();
      await recovered?.reset();
      await race.handler.reset();
    }
  });

  it('reconciles a rejoined remote claim without its pruned row non-authorizing after restart', async () => {
    const session = new FakeSession();
    const requestId = 'remote-pruned-settlement-restart';
    const requestInput = { command: ['bash', '-lc', 'echo restart'] };
    const sourceAuthority = {
      kind: 'mediatedExternal',
      mediatorPluginId: 'happier.channels',
      sourceRef: 'binding:ops',
      sourceRevisionOrEpoch: '42',
      admittedPermissionCeiling: 'default',
      remoteApprovalMaxScope: 'request',
    } as const;
    const response = {
      sessionId: session.sessionId,
      turnId: `turn-${requestId}`,
      requestId,
      sourceRef: 'binding:ops',
      sourceRevisionOrEpoch: '42',
      idempotencyKey: 'remote-pruned-settlement-restart-retry',
      actor: { namespace: 'discord', principalId: 'person-1' },
      decision: 'allow' as const,
      scope: 'request' as const,
      mediator: { pluginId: 'happier.channels', contributionLocalId: 'discord' },
    };
    session.agentState.requests[requestId] = {
      tool: 'Bash',
      arguments: requestInput,
      createdAt: Date.now(),
      turnId: response.turnId,
      kind: 'permission',
      owner: { kind: 'plugin', pluginId: 'happier.channels', sourceAuthority },
      permissionResponseClaimV1: {
        version: 1,
        origin: 'remoteMediation',
        actor: {
          kind: 'externalHuman',
          assurance: 'pluginAsserted',
          namespace: 'discord',
          principalId: 'person-1',
          assertedBy: { pluginId: 'happier.channels', contributionLocalId: 'discord' },
        },
        mediatorPluginId: 'happier.channels',
        turnId: response.turnId,
        sourceRef: 'binding:ops',
        sourceRevisionOrEpoch: '42',
        idempotencyKey: response.idempotencyKey,
        decision: 'allow',
        scope: 'request',
      },
    };
    const recordStore: PermissionMediationRecordStore = {
      read: vi.fn(async () => ({ status: 'absent' as const })),
      createExpectedAbsent: vi.fn(async () => ({ status: 'unavailable' as const })),
      list: vi.fn(async () => ({ status: 'ready' as const, records: [], nextCursor: null, hasNext: false })),
      pruneInactive: vi.fn(async () => ({ status: 'unavailable' as const })),
      compareAndSet: vi.fn(async () => ({ status: 'unavailable' as const })),
    };
    const recovered = new TestPermissionHandler(session as any, { mediationRecordStore: recordStore });
    const pending = recovered.request(requestId, 'Bash', requestInput, {
      causalPermissionContext: {
        turnId: response.turnId,
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'default',
          sourceAuthority,
        },
      },
    });

    try {
      await expect(recovered.respondToMediatedPendingPermission(response)).resolves.toEqual({
        status: 'rejected',
        code: 'requestNotPending',
      });
      await expect(recovered.respondToMediatedPendingPermission({
        ...response,
        requestId: 'remote-unknown-after-pruned-restart',
      })).resolves.toEqual({
        status: 'rejected',
        code: 'requestNotFound',
      });
      await expect(pending).resolves.toEqual({ decision: 'denied' });
      expect(session.agentState.requests[requestId]).toBeUndefined();
      expect(session.agentState.completedRequests[requestId]).toEqual(expect.objectContaining({
        status: 'denied',
        decision: 'denied',
      }));
      expect(recordStore.createExpectedAbsent).not.toHaveBeenCalled();
    } finally {
      await recovered.reset();
      await Promise.allSettled([pending]);
    }
  });

  it('rejects a remote allow when current policy narrowed, while retaining the still-current deny path', async () => {
    const session = new FakeSession();
    let stored: PermissionMediationStoredRecord | null = null;
    const recordStore: PermissionMediationRecordStore = {
      read: vi.fn(async () => (
        stored ? { status: 'found' as const, stored } : { status: 'absent' as const }
      )),
      createExpectedAbsent: vi.fn(async (input) => {
        if (stored) return { status: 'conflict' as const };
        stored = { identity: input.identity, kind: input.kind, record: input.record, revision: 'ssr1.narrowed-policy' };
        return { status: 'created' as const, stored };
      }),
      list: vi.fn(async () => ({ status: 'ready' as const, records: [], nextCursor: null, hasNext: false })),
      pruneInactive: vi.fn(async () => ({ status: 'unavailable' as const })),
      compareAndSet: vi.fn(async () => ({ status: 'unavailable' as const })),
    };
    const handler = new TestPermissionHandler(session as any, { mediationRecordStore: recordStore });
    const sourceAuthority = {
      kind: 'mediatedExternal',
      mediatorPluginId: 'happier.channels',
      sourceRef: 'binding:ops',
      sourceRevisionOrEpoch: '42',
      admittedPermissionCeiling: 'default',
      remoteApprovalMaxScope: 'request',
    } as const;
    const pending = handler.request('narrowed-policy-request', 'Bash', { command: ['bash', '-lc', 'echo policy'] }, {
      causalPermissionContext: {
        turnId: 'turn-narrowed-policy-request',
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'default',
          sourceAuthority,
        },
      },
    });
    const response = {
      sessionId: session.sessionId,
      turnId: 'turn-narrowed-policy-request',
      requestId: 'narrowed-policy-request',
      sourceRef: 'binding:ops',
      sourceRevisionOrEpoch: '42',
      idempotencyKey: 'narrowed-policy-retry',
      actor: { namespace: 'discord', principalId: 'person-1' },
      decision: 'allow' as const,
      scope: 'request' as const,
      mediator: { pluginId: 'happier.channels', contributionLocalId: 'discord' },
    };

    handler.setRemoteMediationAllowEligible(false);
    await expect(handler.respondToMediatedPendingPermission(response)).resolves.toEqual({
      status: 'rejected',
      code: 'permissionCeilingExceeded',
    });
    expect(recordStore.createExpectedAbsent).not.toHaveBeenCalled();
    expect(session.agentState.requests['narrowed-policy-request']).toBeDefined();
    expect(await settledState(pending)).toBe('pending');

    await expect(handler.respondToMediatedPendingPermission({
      ...response,
      decision: 'deny',
    })).resolves.toEqual(expect.objectContaining({
      status: 'applied',
      decision: 'deny',
      effect: { kind: 'deny' },
    }));
    await expect(pending).resolves.toEqual({ decision: 'denied' });
  });

  it('rechecks current remote allow eligibility after asynchronous ledger admission and before the CAS write', async () => {
    const session = new FakeSession();
    const admissionListStarted = createDeferred<void>();
    const releaseAdmissionList = createDeferred<void>();
    let listCalls = 0;
    const recordStore: PermissionMediationRecordStore = {
      read: vi.fn(async () => ({ status: 'absent' as const })),
      createExpectedAbsent: vi.fn(async () => ({ status: 'unavailable' as const })),
      list: vi.fn(async () => {
        listCalls += 1;
        if (listCalls === 2) {
          admissionListStarted.resolve();
          await releaseAdmissionList.promise;
        }
        return { status: 'ready' as const, records: [], nextCursor: null, hasNext: false };
      }),
      pruneInactive: vi.fn(async () => ({ status: 'unavailable' as const })),
      compareAndSet: vi.fn(async () => ({ status: 'unavailable' as const })),
    };
    const handler = new TestPermissionHandler(session as any, { mediationRecordStore: recordStore });
    const sourceAuthority = {
      kind: 'mediatedExternal',
      mediatorPluginId: 'happier.channels',
      sourceRef: 'binding:ops',
      sourceRevisionOrEpoch: '42',
      admittedPermissionCeiling: 'default',
      remoteApprovalMaxScope: 'request',
    } as const;
    const pending = handler.request('policy-after-admission', 'Bash', { command: ['bash', '-lc', 'echo policy'] }, {
      causalPermissionContext: {
        turnId: 'turn-policy-after-admission',
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'default',
          sourceAuthority,
        },
      },
    });
    const remote = handler.respondToMediatedPendingPermission({
      sessionId: session.sessionId,
      turnId: 'turn-policy-after-admission',
      requestId: 'policy-after-admission',
      sourceRef: 'binding:ops',
      sourceRevisionOrEpoch: '42',
      idempotencyKey: 'policy-after-admission-retry',
      actor: { namespace: 'discord', principalId: 'person-1' },
      decision: 'allow',
      scope: 'request',
      mediator: { pluginId: 'happier.channels', contributionLocalId: 'discord' },
    });

    try {
      await admissionListStarted.promise;
      handler.setRemoteMediationAllowEligible(false);
      releaseAdmissionList.resolve();

      await expect(remote).resolves.toEqual({
        status: 'rejected',
        code: 'permissionCeilingExceeded',
      });
      expect(recordStore.createExpectedAbsent).not.toHaveBeenCalled();
      expect(session.agentState.requests['policy-after-admission']).toBeDefined();
      expect(await settledState(pending)).toBe('pending');
    } finally {
      releaseAdmissionList.resolve();
      await handler.reset();
      await Promise.allSettled([remote, pending]);
    }
  });

  it('creates, applies, and CAS-revokes one exact source-bound remote session grant', async () => {
    const session = new FakeSession();
    let mediatorPluginCurrent = true;
    const isMediatorPluginCurrent = vi.fn((pluginId: string) => (
      mediatorPluginCurrent && pluginId === 'happier.channels'
    ));
    let mediatorContributionCurrent = true;
    const isMediatorContributionCurrent = vi.fn((mediator: Readonly<{
      pluginId: string;
      contributionLocalId: string;
    }>) => (
      mediatorContributionCurrent
      && mediator.pluginId === 'happier.channels'
      && mediator.contributionLocalId === 'discord'
    ));
    let stored: PermissionMediationStoredRecord | null = null;
    const readStored = (): PermissionMediationStoredRecord | null => stored;
    const recordStore: PermissionMediationRecordStore = {
      read: vi.fn(async () => (
        stored ? { status: 'found' as const, stored } : { status: 'absent' as const }
      )),
      createExpectedAbsent: vi.fn(async (input) => {
        if (stored) return { status: 'conflict' as const };
        stored = { identity: input.identity, kind: input.kind, record: input.record, revision: 'ssr1.AAAACHNldHRsZW1lbnQtMwAAAAE' };
        return { status: 'created' as const, stored };
      }),
      list: vi.fn(async () => ({
        status: 'ready' as const,
        records: stored ? [stored] : [],
        nextCursor: null,
        hasNext: false,
      })),
      pruneInactive: vi.fn(async () => ({ status: 'unavailable' as const })),
      compareAndSet: vi.fn(async (input) => {
        if (!stored || stored.revision !== input.expectedRevision) return { status: 'conflict' as const };
        stored = { identity: input.identity, kind: input.kind, record: input.record, revision: 'ssr1.AAAACHNldHRsZW1lbnQtMwAAAAI' };
        return { status: 'updated' as const, stored };
      }),
    };
    const handler = new TestPermissionHandler(session as any, {
      mediationRecordStore: recordStore,
      // The lifecycle read is deliberately injected at the permission owner;
      // it models the runtime registry retiring this exact mediator
      // contribution after admission.
      isMediatorPluginCurrent,
      isMediatorContributionCurrent,
    } as any);
    const sourceAuthority = {
      kind: 'mediatedExternal',
      mediatorPluginId: 'happier.channels',
      sourceRef: 'binding:ops',
      sourceRevisionOrEpoch: '42',
      admittedPermissionCeiling: 'default',
      remoteApprovalMaxScope: 'session',
    } as const;
    const input = { command: ['bash', '-lc', 'echo grant'] };
    const pending = handler.request('remote-grant', 'Bash', input, {
      causalPermissionContext: {
        turnId: 'turn-remote-grant',
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'default',
          sourceAuthority,
        },
      },
    });

    const response = await handler.respondToMediatedPendingPermission({
      sessionId: session.sessionId,
      turnId: 'turn-remote-grant',
      requestId: 'remote-grant',
      sourceRef: 'binding:ops',
      sourceRevisionOrEpoch: '42',
      idempotencyKey: 'grant-1',
      actor: { namespace: 'discord', principalId: 'person-1' },
      decision: 'allow',
      scope: 'session',
      mediator: { pluginId: 'happier.channels', contributionLocalId: 'discord' },
    });
    expect(response).toEqual(expect.objectContaining({
      status: 'applied',
      decision: 'allow',
      effect: expect.objectContaining({ kind: 'sessionGrant', grantId: expect.any(String) }),
    }));
    await expect(pending).resolves.toEqual({ decision: 'approved' });
    expect(readStored()?.kind).toBe('remote_grant.v1');
    expect(handler.isAllowedByRemoteGrant('Bash', input, sourceAuthority)).toBe(true);
    expect(handler.isAllowedByRemoteGrant('Bash', { command: ['bash', '-lc', 'echo different'] }, sourceAuthority)).toBe(false);
    expect(handler.isAllowedByRemoteGrant('Bash', input, {
      ...sourceAuthority,
      sourceRevisionOrEpoch: '43',
    })).toBe(false);
    expect(isMediatorContributionCurrent).toHaveBeenCalledWith({
      pluginId: 'happier.channels',
      contributionLocalId: 'discord',
    });

    mediatorPluginCurrent = false;
    expect(handler.isAllowedByRemoteGrant('Bash', input, sourceAuthority)).toBe(false);

    mediatorPluginCurrent = true;
    mediatorContributionCurrent = false;
    expect(handler.isAllowedByRemoteGrant('Bash', input, sourceAuthority)).toBe(false);

    const grantId = response.status === 'rejected' || response.effect.kind !== 'sessionGrant'
      ? ''
      : response.effect.grantId;
    await expect(handler.revokeMediatedPermissionGrant({
      turnId: 'turn-remote-grant',
      requestId: 'remote-grant',
      grantId,
      caller: { kind: 'mediatorPlugin', pluginId: 'happier.channels' },
    })).resolves.toEqual({ status: 'revoked', grantId });
    expect(handler.isAllowedByRemoteGrant('Bash', input, sourceAuthority)).toBe(false);
    expect(recordStore.compareAndSet).toHaveBeenCalledWith(expect.objectContaining({
      identity: {
        sessionId: session.sessionId,
        turnId: 'turn-remote-grant',
        requestId: 'remote-grant',
      },
      expectedRevision: 'ssr1.AAAACHNldHRsZW1lbnQtMwAAAAE',
    }));
  });

  it.each([
    [
      'the caller is canceled after the remote CAS commits',
      { status: 'rejected', code: 'canceled' },
      'updated',
    ],
    [
      'the remote CAS result is unavailable after it commits',
      { status: 'rejected', code: 'mediationStateUnavailable' },
      'unavailable',
    ],
  ] as const)(
    'removes the active grant when %s',
    async (_name, outcome, commitResult) => {
      const session = new FakeSession();
      const abort = new AbortController();
      let stored: PermissionMediationStoredRecord | null = null;
      const recordStore: PermissionMediationRecordStore = {
        read: vi.fn(async () => (
          stored ? { status: 'found' as const, stored } : { status: 'absent' as const }
        )),
        createExpectedAbsent: vi.fn(async (input) => {
          if (stored) return { status: 'conflict' as const };
          stored = { identity: input.identity, kind: input.kind, record: input.record, revision: 'ssr1.revoke-ambiguous-1' };
          return { status: 'created' as const, stored };
        }),
        list: vi.fn(async () => ({
          status: 'ready' as const,
          records: stored ? [stored] : [],
          nextCursor: null,
          hasNext: false,
        })),
        pruneInactive: vi.fn(async () => ({ status: 'unavailable' as const })),
        compareAndSet: vi.fn(async (input) => {
          if (!stored || stored.revision !== input.expectedRevision) return { status: 'conflict' as const };
          stored = { identity: input.identity, kind: input.kind, record: input.record, revision: 'ssr1.revoke-ambiguous-2' };
          if (commitResult === 'updated') {
            abort.abort();
            return { status: 'updated' as const, stored };
          }
          return { status: 'unavailable' as const };
        }),
      };
      const handler = new TestPermissionHandler(session as any, { mediationRecordStore: recordStore });
      const sourceAuthority = {
        kind: 'mediatedExternal',
        mediatorPluginId: 'happier.channels',
        sourceRef: 'binding:ops',
        sourceRevisionOrEpoch: '42',
        admittedPermissionCeiling: 'default',
        remoteApprovalMaxScope: 'session',
      } as const;
      const input = { command: ['bash', '-lc', 'echo ambiguous revoke'] };
      const pending = handler.request('remote-revoke-ambiguous', 'Bash', input, {
        causalPermissionContext: {
          turnId: 'turn-remote-revoke-ambiguous',
          causalPermissionAuthority: {
            kind: 'admittedSessionInputV1',
            admittedPermissionCeiling: 'default',
            sourceAuthority,
          },
        },
      });

      try {
        const applied = await handler.respondToMediatedPendingPermission({
          sessionId: session.sessionId,
          turnId: 'turn-remote-revoke-ambiguous',
          requestId: 'remote-revoke-ambiguous',
          sourceRef: 'binding:ops',
          sourceRevisionOrEpoch: '42',
          idempotencyKey: 'remote-revoke-ambiguous-key',
          actor: { namespace: 'discord', principalId: 'person-1' },
          decision: 'allow',
          scope: 'session',
          mediator: { pluginId: 'happier.channels', contributionLocalId: 'discord' },
        });
        if (applied.status === 'rejected' || applied.effect.kind !== 'sessionGrant') {
          throw new Error('Expected an active remote session grant');
        }
        await expect(pending).resolves.toEqual({ decision: 'approved' });
        expect(handler.isAllowedByRemoteGrant('Bash', input, sourceAuthority)).toBe(true);

        await expect(handler.revokeMediatedPermissionGrant({
          turnId: 'turn-remote-revoke-ambiguous',
          requestId: 'remote-revoke-ambiguous',
          grantId: applied.effect.grantId,
          caller: { kind: 'host' },
          signal: abort.signal,
        })).resolves.toEqual(outcome);
        expect(stored).toEqual(expect.objectContaining({
          kind: 'remote_grant.v1',
          record: expect.objectContaining({ revoked: expect.any(Object) }),
        }));
        expect(handler.isAllowedByRemoteGrant('Bash', input, sourceAuthority)).toBe(false);
      } finally {
        await handler.reset();
        await Promise.allSettled([pending]);
      }
    },
  );

  it('does not let an untyped public revoke bypass hydration and republish a revoked grant', async () => {
    const session = new FakeSession();
    const requestId = 'revoke-hydration-bypass-republish';
    const baseGrant = activeRemoteMediationGrant(11);
    if (baseGrant.kind !== 'remote_grant.v1') throw new Error('Expected remote grant fixture');
    if (baseGrant.record.effect.kind !== 'sessionGrant') throw new Error('Expected session grant effect');
    let stored: PermissionMediationStoredRecord = {
      ...baseGrant,
      identity: {
        ...baseGrant.identity,
        turnId: `turn-${requestId}`,
        requestId,
      },
      record: {
        ...baseGrant.record,
        turnId: `turn-${requestId}`,
        requestId,
        idempotencyKey: 'revoke-hydration-bypass-republish-key',
        effect: {
          ...baseGrant.record.effect,
          grantId: 'revoke-hydration-bypass-republish-grant',
          rule: { kind: 'exactTool', identifier: 'Bash' },
        },
      },
    };
    const sourceAuthority = stored.record.sourceAuthority;
    const listStarted = createDeferred<void>();
    const releaseList = createDeferred<void>();
    const casStarted = createDeferred<void>();
    let holdFirstList = true;
    const recordStore: PermissionMediationRecordStore = {
      read: vi.fn(async () => ({ status: 'found' as const, stored })),
      createExpectedAbsent: vi.fn(async () => ({ status: 'conflict' as const })),
      list: vi.fn(async () => {
        const staleStored = stored;
        if (holdFirstList) {
          holdFirstList = false;
          listStarted.resolve();
          await releaseList.promise;
        }
        return {
          status: 'ready' as const,
          records: [staleStored],
          nextCursor: null,
          hasNext: false,
        };
      }),
      pruneInactive: vi.fn(async () => ({ status: 'unavailable' as const })),
      compareAndSet: vi.fn(async (input) => {
        if (stored.revision !== input.expectedRevision) return { status: 'conflict' as const };
        casStarted.resolve();
        stored = { identity: input.identity, kind: input.kind, record: input.record, revision: 'ssr1.revoke-hydration-bypass-republish-2' };
        return { status: 'updated' as const, stored };
      }),
    };
    const handler = new TestPermissionHandler(session as any, { mediationRecordStore: recordStore });
    let revoke: Promise<unknown> | null = null;

    try {
      await listStarted.promise;
      // Exercise an untyped caller: removing the public option must make this
      // otherwise-extra property inert at the canonical revoke owner.
      revoke = Reflect.apply(handler.revokeMediatedPermissionGrant, handler, [{
        turnId: stored.identity.turnId,
        requestId,
        grantId: 'revoke-hydration-bypass-republish-grant',
        caller: { kind: 'mediatorPlugin', pluginId: 'happier.channels' },
        skipRemoteMediationGrantHydration: true,
      }]);
      expect(await settledState(casStarted.promise)).toBe('pending');

      releaseList.resolve();
      await expect(revoke).resolves.toEqual({
        status: 'revoked',
        grantId: 'revoke-hydration-bypass-republish-grant',
      });
      expect(handler.isAllowedByRemoteGrant('Bash', {}, sourceAuthority)).toBe(false);
    } finally {
      releaseList.resolve();
      await handler.reset();
      if (revoke) await Promise.allSettled([revoke]);
    }
  });

  it('does not reactivate a revoked grant from an unrelated stale ledger admission', async () => {
    const session = new FakeSession();
    const sourceAuthority = {
      kind: 'mediatedExternal',
      mediatorPluginId: 'happier.channels',
      sourceRef: 'binding:stale-ledger-admission',
      sourceRevisionOrEpoch: '42',
      admittedPermissionCeiling: 'default',
      remoteApprovalMaxScope: 'session',
    } as const;
    const rows = new Map<string, PermissionMediationStoredRecord>();
    const identityKey = (identity: PermissionMediationStoredRecord['identity']) => (
      `${identity.sessionId}:${identity.turnId}:${identity.requestId}`
    );
    const staleListCaptured = createDeferred<void>();
    const releaseStaleList = createDeferred<void>();
    let holdNextList = false;
    const recordStore: PermissionMediationRecordStore = {
      read: vi.fn(async ({ identity }) => {
        const stored = rows.get(identityKey(identity));
        return stored ? { status: 'found' as const, stored } : { status: 'absent' as const };
      }),
      createExpectedAbsent: vi.fn(async (input) => {
        const key = identityKey(input.identity);
        if (rows.has(key)) return { status: 'conflict' as const };
        const stored: PermissionMediationStoredRecord = {
          identity: input.identity,
          kind: input.kind,
          record: input.record,
          revision: `ssr1.${input.identity.requestId}`,
        };
        rows.set(key, stored);
        return { status: 'created' as const, stored };
      }),
      list: vi.fn(async () => {
        const snapshot = [...rows.values()];
        if (holdNextList) {
          holdNextList = false;
          staleListCaptured.resolve();
          await releaseStaleList.promise;
        }
        return {
          status: 'ready' as const,
          records: snapshot,
          nextCursor: null,
          hasNext: false,
        };
      }),
      pruneInactive: vi.fn(async () => ({ status: 'unavailable' as const })),
      compareAndSet: vi.fn(async (input) => {
        const key = identityKey(input.identity);
        const current = rows.get(key);
        if (!current || current.revision !== input.expectedRevision) return { status: 'conflict' as const };
        const stored: PermissionMediationStoredRecord = {
          identity: input.identity,
          kind: input.kind,
          record: input.record,
          revision: `${current.revision}-revoked`,
        };
        rows.set(key, stored);
        return { status: 'updated' as const, stored };
      }),
    };
    const handler = new TestPermissionHandler(session as any, { mediationRecordStore: recordStore });
    const grantRequestId = 'stale-ledger-grant';
    const grantInput = { command: ['bash', '-lc', 'echo stale ledger grant'] };
    const grantPending = handler.request(grantRequestId, 'Bash', grantInput, {
      causalPermissionContext: {
        turnId: `turn-${grantRequestId}`,
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'default',
          sourceAuthority,
        },
      },
    });
    const grantResponse = handler.respondToMediatedPendingPermission({
      sessionId: session.sessionId,
      turnId: `turn-${grantRequestId}`,
      requestId: grantRequestId,
      sourceRef: sourceAuthority.sourceRef,
      sourceRevisionOrEpoch: sourceAuthority.sourceRevisionOrEpoch,
      idempotencyKey: 'stale-ledger-grant-key',
      actor: { namespace: 'discord', principalId: 'person-1' },
      decision: 'allow',
      scope: 'session',
      mediator: { pluginId: 'happier.channels', contributionLocalId: 'discord' },
    });
    let unrelated: Promise<unknown> | null = null;
    let revoke: Promise<unknown> | null = null;

    try {
      const applied = await grantResponse;
      if (applied.status === 'rejected' || applied.effect.kind !== 'sessionGrant') {
        throw new Error('Expected an active remote session grant');
      }
      await expect(grantPending).resolves.toEqual({ decision: 'approved' });
      expect(handler.isAllowedByRemoteGrant('Bash', grantInput, sourceAuthority)).toBe(true);

      const unrelatedRequestId = 'stale-ledger-unrelated-settlement';
      const unrelatedInput = { command: ['bash', '-lc', 'echo unrelated settlement'] };
      const unrelatedPending = handler.request(unrelatedRequestId, 'Bash', unrelatedInput, {
        causalPermissionContext: {
          turnId: `turn-${unrelatedRequestId}`,
          causalPermissionAuthority: {
            kind: 'admittedSessionInputV1',
            admittedPermissionCeiling: 'default',
            sourceAuthority,
          },
        },
      });
      holdNextList = true;
      unrelated = handler.respondToMediatedPendingPermission({
        sessionId: session.sessionId,
        turnId: `turn-${unrelatedRequestId}`,
        requestId: unrelatedRequestId,
        sourceRef: sourceAuthority.sourceRef,
        sourceRevisionOrEpoch: sourceAuthority.sourceRevisionOrEpoch,
        idempotencyKey: 'stale-ledger-unrelated-settlement-key',
        actor: { namespace: 'discord', principalId: 'person-1' },
        decision: 'allow',
        scope: 'request',
        mediator: { pluginId: 'happier.channels', contributionLocalId: 'discord' },
      });
      await staleListCaptured.promise;

      revoke = handler.revokeMediatedPermissionGrant({
        turnId: `turn-${grantRequestId}`,
        requestId: grantRequestId,
        grantId: applied.effect.grantId,
        caller: { kind: 'host' },
      });
      // Before the ledger owner is shared by revoke, this gives its CAS and
      // local delete a turn before the stale admission resumes.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      releaseStaleList.resolve();
      await expect(unrelated).resolves.toEqual(expect.objectContaining({ status: 'applied' }));
      await expect(unrelatedPending).resolves.toEqual({ decision: 'approved' });
      await expect(revoke).resolves.toEqual({ status: 'revoked', grantId: applied.effect.grantId });
      expect(handler.isAllowedByRemoteGrant('Bash', grantInput, sourceAuthority)).toBe(false);
    } finally {
      releaseStaleList.resolve();
      await handler.reset();
      await Promise.allSettled([grantResponse, grantPending, ...(unrelated ? [unrelated] : []), ...(revoke ? [revoke] : [])]);
    }
  });

  it('preserves a replacement-session grant when an old-ledger revoke CAS returns', async () => {
    const session = new FakeSession();
    const replacementSession = new FakeSession();
    const casCommitted = createDeferred<void>();
    const releaseCas = createDeferred<void>();
    const replacementListStarted = createDeferred<void>();
    const stored: { current: PermissionMediationStoredRecord | null } = { current: null };
    let replacement: PermissionMediationStoredRecord | null = null;
    let pauseRevokeCas = false;
    const recordStore: PermissionMediationRecordStore = {
      read: vi.fn(async () => (
        stored.current ? { status: 'found' as const, stored: stored.current } : { status: 'absent' as const }
      )),
      createExpectedAbsent: vi.fn(async (input) => {
        if (stored.current) return { status: 'conflict' as const };
        const created: PermissionMediationStoredRecord = {
          identity: input.identity,
          kind: input.kind,
          record: input.record,
          revision: 'ssr1.old-ledger-grant-1',
        };
        stored.current = created;
        return { status: 'created' as const, stored: created };
      }),
      list: vi.fn(async () => {
        if (replacement) {
          replacementListStarted.resolve();
          return {
            status: 'ready' as const,
            records: [replacement],
            nextCursor: null,
            hasNext: false,
          };
        }
        return {
          status: 'ready' as const,
          records: stored.current ? [stored.current] : [],
          nextCursor: null,
          hasNext: false,
        };
      }),
      pruneInactive: vi.fn(async () => ({ status: 'unavailable' as const })),
      compareAndSet: vi.fn(async (input) => {
        if (!stored.current || stored.current.revision !== input.expectedRevision) return { status: 'conflict' as const };
        const revoked: PermissionMediationStoredRecord = {
          identity: input.identity,
          kind: input.kind,
          record: input.record,
          revision: 'ssr1.old-ledger-grant-2',
        };
        if (!pauseRevokeCas) {
          stored.current = revoked;
          return { status: 'updated' as const, stored: revoked };
        }
        stored.current = revoked;
        casCommitted.resolve();
        await releaseCas.promise;
        return { status: 'updated' as const, stored: revoked };
      }),
    };
    const handler = new TestPermissionHandler(session as any, { mediationRecordStore: recordStore });
    const sourceAuthority = {
      kind: 'mediatedExternal',
      mediatorPluginId: 'happier.channels',
      sourceRef: 'binding:ops',
      sourceRevisionOrEpoch: '42',
      admittedPermissionCeiling: 'default',
      remoteApprovalMaxScope: 'session',
    } as const;
    const requestId = 'old-ledger-revoke';
    const input = { command: ['bash', '-lc', 'echo replacement grant'] };
    const pending = handler.request(requestId, 'Bash', input, {
      causalPermissionContext: {
        turnId: `turn-${requestId}`,
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'default',
          sourceAuthority,
        },
      },
    });
    let revoke: Promise<unknown> | null = null;

    try {
      const applied = await handler.respondToMediatedPendingPermission({
        sessionId: session.sessionId,
        turnId: `turn-${requestId}`,
        requestId,
        sourceRef: sourceAuthority.sourceRef,
        sourceRevisionOrEpoch: sourceAuthority.sourceRevisionOrEpoch,
        idempotencyKey: 'old-ledger-revoke-key',
        actor: { namespace: 'discord', principalId: 'person-1' },
        decision: 'allow',
        scope: 'session',
        mediator: { pluginId: 'happier.channels', contributionLocalId: 'discord' },
      });
      if (applied.status === 'rejected' || applied.effect.kind !== 'sessionGrant') {
        throw new Error('Expected an active remote session grant');
      }
      await expect(pending).resolves.toEqual({ decision: 'approved' });
      expect(handler.isAllowedByRemoteGrant('Bash', input, sourceAuthority)).toBe(true);

      const original = stored.current;
      if (original?.kind !== 'remote_grant.v1' || original.record.effect.kind !== 'sessionGrant') {
        throw new Error('Expected the original active remote grant');
      }
      replacement = {
        identity: original.identity,
        kind: 'remote_grant.v1',
        record: {
          ...original.record,
          settlementId: 'replacement-session-settlement',
          effect: {
            ...original.record.effect,
            grantId: 'replacement-session-grant',
          },
        },
        revision: 'ssr1.replacement-session-grant',
      };
      replacementSession.agentState.completedRequests[requestId] = {
        turnId: replacement.record.turnId,
        status: 'approved',
        remoteMediationSettlementId: replacement.record.settlementId,
      };

      pauseRevokeCas = true;
      revoke = handler.revokeMediatedPermissionGrant({
        turnId: original.identity.turnId,
        requestId,
        grantId: original.record.effect.grantId,
        caller: { kind: 'host' },
      });
      if (!revoke) throw new Error('Expected revoke to start');
      await casCommitted.promise;

      handler.updateSession(replacementSession as any);
      await replacementListStarted.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(handler.isAllowedByRemoteGrant('Bash', input, sourceAuthority)).toBe(true);

      releaseCas.resolve();
      await expect(revoke).resolves.toEqual({ status: 'rejected', code: 'mediationStateUnavailable' });
      expect(handler.isAllowedByRemoteGrant('Bash', input, sourceAuthority)).toBe(true);
    } finally {
      releaseCas.resolve();
      await handler.reset();
      await Promise.allSettled([pending, ...(revoke ? [revoke] : [])]);
    }
  });

  it('settles non-authorizing when a session grant is revoked after CAS but before ordinary completion', async () => {
    const race = startBlockedRemoteSettlement({
      requestId: 'remote-revoked-before-completion',
      scope: 'session',
      pauseAfterCreate: true,
    });
    const input = { command: ['bash', '-lc', 'echo race'] };

    try {
      await race.rowCreateStarted.promise;
      const stored = race.readStored();
      if (stored?.kind !== 'remote_grant.v1') throw new Error('Expected committed remote grant');
      if (stored.record.effect.kind !== 'sessionGrant') throw new Error('Expected session grant effect');

      const revoked = race.handler.revokeMediatedPermissionGrant({
        turnId: stored.identity.turnId,
        requestId: stored.record.requestId,
        grantId: stored.record.effect.grantId,
        caller: { kind: 'host' },
      });
      // With the canonical completion phase decoupled from the grant CAS, the
      // revocation reaches the durable row while ordinary completion remains
      // paused. The prior whole-response coordinator lock makes this wait a
      // no-op, which is the intended RED discriminator.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      race.releaseRowCreate.resolve();

      await expect(race.remote).resolves.toEqual({
        status: 'rejected',
        code: 'requestNotPending',
      });
      await expect(revoked).resolves.toEqual({ status: 'revoked', grantId: stored.record.effect.grantId });
      await expect(race.pending).resolves.toEqual({ decision: 'denied' });
      expect(race.session.agentState.requests['remote-revoked-before-completion']).toBeUndefined();
      expect(race.session.agentState.completedRequests['remote-revoked-before-completion']).toEqual(
        expect.objectContaining({
          status: 'denied',
          decision: 'denied',
          remoteMediationSettlementId: stored.record.settlementId,
        }),
      );
      expect(race.handler.isAllowedByRemoteGrant('Bash', input, race.sourceAuthority)).toBe(false);
    } finally {
      race.releaseRowCreate.resolve();
      await Promise.allSettled([race.remote, race.pending]);
      await race.handler.reset();
    }
  });

  it('keeps a committed session grant inactive until the ordinary completion projection commits', async () => {
    const session = new DeferredUpdateSession();
    const rowCreated = createDeferred<void>();
    const stored: { current: PermissionMediationStoredRecord | null } = { current: null };
    const recordStore: PermissionMediationRecordStore = {
      read: vi.fn(async () => (
        stored.current ? { status: 'found' as const, stored: stored.current } : { status: 'absent' as const }
      )),
      createExpectedAbsent: vi.fn(async (input) => {
        if (stored.current) return { status: 'conflict' as const };
        const created: PermissionMediationStoredRecord = {
          identity: input.identity,
          kind: input.kind,
          record: input.record,
          revision: 'ssr1.grant-before-completion',
        };
        stored.current = created;
        session.deferNextUpdate();
        rowCreated.resolve();
        return { status: 'created' as const, stored: created };
      }),
      list: vi.fn(async () => ({
        status: 'ready' as const,
        records: stored.current ? [stored.current] : [],
        nextCursor: null,
        hasNext: false,
      })),
      pruneInactive: vi.fn(async () => ({ status: 'unavailable' as const })),
      compareAndSet: vi.fn(async () => ({ status: 'unavailable' as const })),
    };
    const handler = new TestPermissionHandler(session as any, { mediationRecordStore: recordStore });
    const sourceAuthority = {
      kind: 'mediatedExternal',
      mediatorPluginId: 'happier.channels',
      sourceRef: 'binding:completion-race',
      sourceRevisionOrEpoch: '42',
      admittedPermissionCeiling: 'default',
      remoteApprovalMaxScope: 'session',
    } as const;
    const input = { command: ['bash', '-lc', 'echo completion race'] };
    const pending = handler.request('grant-before-completion', 'Bash', input, {
      causalPermissionContext: {
        turnId: 'turn-grant-before-completion',
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'default',
          sourceAuthority,
        },
      },
    });
    const remote = handler.respondToMediatedPendingPermission({
      sessionId: session.sessionId,
      turnId: 'turn-grant-before-completion',
      requestId: 'grant-before-completion',
      sourceRef: sourceAuthority.sourceRef,
      sourceRevisionOrEpoch: sourceAuthority.sourceRevisionOrEpoch,
      idempotencyKey: 'grant-before-completion-retry',
      actor: { namespace: 'discord', principalId: 'person-1' },
      decision: 'allow',
      scope: 'session',
      mediator: { pluginId: 'happier.channels', contributionLocalId: 'discord' },
    });

    try {
      await rowCreated.promise;
      await Promise.resolve();

      expect(stored.current?.kind).toBe('remote_grant.v1');
      expect(session.agentState.requests['grant-before-completion']).toBeDefined();
      expect(session.agentState.completedRequests['grant-before-completion']).toBeUndefined();
      expect(handler.isAllowedByRemoteGrant('Bash', input, sourceAuthority)).toBe(false);
      expect(await settledState(pending)).toBe('pending');

      session.releaseDeferredUpdate();

      await expect(remote).resolves.toEqual(expect.objectContaining({
        status: 'applied',
        effect: expect.objectContaining({ kind: 'sessionGrant' }),
      }));
      await expect(pending).resolves.toEqual({ decision: 'approved' });
      expect(handler.isAllowedByRemoteGrant('Bash', input, sourceAuthority)).toBe(true);
    } finally {
      session.releaseDeferredUpdate();
      await handler.reset();
      await Promise.allSettled([remote, pending]);
    }
  });

  it('does not complete or activate a session-A grant after session B replaces its ledger', async () => {
    const sessionA = new DeferredUpdateSession();
    const sessionB = new FakeSession();
    sessionB.sessionId = 'session-2';
    sessionB.rpcHandlerManager = new FakeRpcHandlerManager(sessionB.sessionId);
    const terminalUpdateStarted = createDeferred<void>();
    let stored: PermissionMediationStoredRecord | null = null;
    const recordStore: PermissionMediationRecordStore = {
      read: vi.fn(async () => (
        stored ? { status: 'found' as const, stored } : { status: 'absent' as const }
      )),
      createExpectedAbsent: vi.fn(async (input) => {
        if (stored) return { status: 'conflict' as const };
        stored = {
          identity: input.identity,
          kind: input.kind,
          record: input.record,
          revision: 'ssr1.session-a-grant',
        };
        return { status: 'created' as const, stored };
      }),
      // The injected test ledger represents the new session's empty scope
      // after the swap; exact reads still expose Session A's in-flight row.
      list: vi.fn(async () => ({
        status: 'ready' as const,
        records: [],
        nextCursor: null,
        hasNext: false,
      })),
      pruneInactive: vi.fn(async () => ({ status: 'unavailable' as const })),
      compareAndSet: vi.fn(async () => ({ status: 'unavailable' as const })),
    };
    const handler = new TestPermissionHandler(sessionA as any, { mediationRecordStore: recordStore });
    const sourceAuthority = {
      kind: 'mediatedExternal',
      mediatorPluginId: 'happier.channels',
      sourceRef: 'binding:session-swap-completion',
      sourceRevisionOrEpoch: '42',
      admittedPermissionCeiling: 'default',
      remoteApprovalMaxScope: 'session',
    } as const;
    const requestId = 'session-a-completion-after-swap';
    const input = { command: ['bash', '-lc', 'echo session swap completion'] };
    const pending = handler.request(requestId, 'Bash', input, {
      causalPermissionContext: {
        turnId: `turn-${requestId}`,
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'default',
          sourceAuthority,
        },
      },
    });
    const updateAgentState = sessionA.updateAgentState.bind(sessionA);
    let remoteAgentStateUpdates = 0;
    sessionA.updateAgentState = (updater: any) => {
      remoteAgentStateUpdates += 1;
      // The first two updates acquire and reaffirm the durable remote claim.
      // The third is the ordinary terminal projection reached after replay's
      // exact row read.
      if (remoteAgentStateUpdates === 3) {
        sessionA.deferNextUpdate();
        terminalUpdateStarted.resolve();
      }
      return updateAgentState(updater);
    };
    const remote = handler.respondToMediatedPendingPermission({
      sessionId: sessionA.sessionId,
      turnId: `turn-${requestId}`,
      requestId,
      sourceRef: sourceAuthority.sourceRef,
      sourceRevisionOrEpoch: sourceAuthority.sourceRevisionOrEpoch,
      idempotencyKey: 'session-a-completion-after-swap-key',
      actor: { namespace: 'discord', principalId: 'person-1' },
      decision: 'allow',
      scope: 'session',
      mediator: { pluginId: 'happier.channels', contributionLocalId: 'discord' },
    });

    try {
      // The deferred terminal write begins only after replay has re-read its
      // exact grant row. Swap and hydrate the replacement before that write
      // can resume.
      await terminalUpdateStarted.promise;
      handler.updateSession(sessionB as any);
      await Promise.resolve();
      await Promise.resolve();

      sessionA.releaseDeferredUpdate();

      await expect(remote).resolves.toEqual({
        status: 'rejected',
        code: 'mediationStateUnavailable',
      });
      expect(sessionA.agentState.completedRequests[requestId]).toBeUndefined();
      expect(sessionB.agentState.completedRequests[requestId]).toBeUndefined();
      expect(handler.isAllowedByRemoteGrant('Bash', input, sourceAuthority)).toBe(false);
    } finally {
      sessionA.releaseDeferredUpdate();
      await handler.reset();
      await Promise.allSettled([remote, pending]);
    }
  });

  it('does not hold a revoke claim while startup hydration needs that request to reconcile', async () => {
    const session = new FakeSession();
    const requestId = 'revoke-hydration-claim-race';
    const baseGrant = activeRemoteMediationGrant(9);
    if (baseGrant.kind !== 'remote_grant.v1') throw new Error('Expected remote grant fixture');
    if (baseGrant.record.effect.kind !== 'sessionGrant') throw new Error('Expected session grant effect');
    let stored: PermissionMediationStoredRecord = {
      ...baseGrant,
      identity: {
        ...baseGrant.identity,
        turnId: `turn-${requestId}`,
        requestId,
      },
      record: {
        ...baseGrant.record,
        turnId: `turn-${requestId}`,
        requestId,
        idempotencyKey: 'revoke-hydration-claim-race-key',
        effect: {
          ...baseGrant.record.effect,
          grantId: 'revoke-hydration-claim-race-grant',
        },
      },
    };
    const sourceAuthority = stored.record.sourceAuthority;
    session.agentState.requests[requestId] = {
      tool: 'Bash',
      kind: 'permission',
      arguments: { command: ['bash', '-lc', 'echo revoke hydration'] },
      createdAt: 1,
      turnId: stored.identity.turnId,
      owner: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        sourceAuthority,
      },
      permissionResponseClaimV1: {
        version: 1,
        origin: 'remoteMediation',
        actor: stored.record.actor,
        mediatorPluginId: stored.record.mediatorPluginId,
        turnId: stored.identity.turnId,
        sourceRef: sourceAuthority.sourceRef,
        sourceRevisionOrEpoch: sourceAuthority.sourceRevisionOrEpoch,
        idempotencyKey: stored.record.idempotencyKey,
        decision: stored.record.decision,
        scope: stored.record.requestedScope,
      },
    };
    const listStarted = createDeferred<void>();
    const releaseList = createDeferred<void>();
    let holdFirstList = true;
    const recordStore: PermissionMediationRecordStore = {
      read: vi.fn(async () => ({ status: 'found' as const, stored })),
      createExpectedAbsent: vi.fn(async () => ({ status: 'conflict' as const })),
      list: vi.fn(async () => {
        if (holdFirstList) {
          holdFirstList = false;
          listStarted.resolve();
          await releaseList.promise;
        }
        return {
          status: 'ready' as const,
          records: [stored],
          nextCursor: null,
          hasNext: false,
        };
      }),
      pruneInactive: vi.fn(async () => ({ status: 'unavailable' as const })),
      compareAndSet: vi.fn(async (input) => {
        if (stored.revision !== input.expectedRevision) return { status: 'conflict' as const };
        stored = { identity: input.identity, kind: input.kind, record: input.record, revision: 'ssr1.revoke-hydration-claim-race-2' };
        return { status: 'updated' as const, stored };
      }),
    };
    const handler = new TestPermissionHandler(session as any, { mediationRecordStore: recordStore });
    const revoke = handler.revokeMediatedPermissionGrant({
      turnId: stored.identity.turnId,
      requestId,
      grantId: 'revoke-hydration-claim-race-grant',
      caller: { kind: 'host' },
    });
    let state: 'pending' | 'fulfilled' | 'rejected' = 'pending';

    try {
      await listStarted.promise;
      await Promise.resolve();
      await Promise.resolve();
      releaseList.resolve();

      state = await settledState(revoke);
      expect(state).toBe('fulfilled');
      if (state !== 'fulfilled') return;

      await expect(revoke).resolves.toEqual({
        status: 'revoked',
        grantId: 'revoke-hydration-claim-race-grant',
      });
      expect(session.agentState.requests[requestId]).toBeUndefined();
    } finally {
      releaseList.resolve();
      await handler.reset();
      if (state === 'fulfilled') await Promise.allSettled([revoke]);
    }
  });

  it('does not hold the ledger mutation owner while startup hydration needs it to neutralize a stale grant', async () => {
    const session = new FakeSession();
    const staleRequestId = 'stale-hydration-ledger-owner';
    const baseGrant = activeRemoteMediationGrant(11);
    if (baseGrant.kind !== 'remote_grant.v1') throw new Error('Expected remote grant fixture');
    if (baseGrant.record.effect.kind !== 'sessionGrant') throw new Error('Expected session grant effect');
    const staleGrant: PermissionMediationStoredRecord = {
      ...baseGrant,
      identity: {
        ...baseGrant.identity,
        turnId: `turn-${staleRequestId}`,
        requestId: staleRequestId,
      },
      record: {
        ...baseGrant.record,
        turnId: `turn-${staleRequestId}`,
        requestId: staleRequestId,
        idempotencyKey: 'stale-hydration-ledger-owner-key',
        effect: {
          ...baseGrant.record.effect,
          grantId: 'stale-hydration-ledger-owner-grant',
        },
      },
    };
    const sourceAuthority = staleGrant.record.sourceAuthority;
    session.agentState.requests[staleRequestId] = {
      tool: 'Bash',
      kind: 'permission',
      arguments: { command: ['bash', '-lc', 'echo stale hydration'] },
      createdAt: 1,
      turnId: staleGrant.identity.turnId,
      owner: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        sourceAuthority: {
          ...sourceAuthority,
          sourceRevisionOrEpoch: '43',
        },
      },
      permissionResponseClaimV1: {
        version: 1,
        origin: 'remoteMediation',
        actor: staleGrant.record.actor,
        mediatorPluginId: staleGrant.record.mediatorPluginId,
        turnId: staleGrant.identity.turnId,
        sourceRef: sourceAuthority.sourceRef,
        sourceRevisionOrEpoch: sourceAuthority.sourceRevisionOrEpoch,
        idempotencyKey: staleGrant.record.idempotencyKey,
        decision: staleGrant.record.decision,
        scope: staleGrant.record.requestedScope,
      },
    };
    const identityKey = (identity: PermissionMediationStoredRecord['identity']) => (
      `${identity.sessionId}:${identity.turnId}:${identity.requestId}`
    );
    const rows = new Map<string, PermissionMediationStoredRecord>([[identityKey(staleGrant.identity), staleGrant]]);
    const hydrationListStarted = createDeferred<void>();
    const releaseHydrationList = createDeferred<void>();
    let holdFirstList = true;
    const recordStore: PermissionMediationRecordStore = {
      read: vi.fn(async ({ identity }) => {
        const stored = rows.get(identityKey(identity));
        return stored ? { status: 'found' as const, stored } : { status: 'absent' as const };
      }),
      createExpectedAbsent: vi.fn(async (input) => {
        const key = identityKey(input.identity);
        if (rows.has(key)) return { status: 'conflict' as const };
        const stored: PermissionMediationStoredRecord = {
          identity: input.identity,
          kind: input.kind,
          record: input.record,
          revision: `ssr1.${input.identity.requestId}`,
        };
        rows.set(key, stored);
        return { status: 'created' as const, stored };
      }),
      list: vi.fn(async () => {
        const snapshot = [...rows.values()];
        if (holdFirstList) {
          holdFirstList = false;
          hydrationListStarted.resolve();
          await releaseHydrationList.promise;
        }
        return {
          status: 'ready' as const,
          records: snapshot,
          nextCursor: null,
          hasNext: false,
        };
      }),
      pruneInactive: vi.fn(async () => ({ status: 'unavailable' as const })),
      compareAndSet: vi.fn(async (input) => {
        const key = identityKey(input.identity);
        const current = rows.get(key);
        if (!current || current.revision !== input.expectedRevision) return { status: 'conflict' as const };
        const stored: PermissionMediationStoredRecord = {
          identity: input.identity,
          kind: input.kind,
          record: input.record,
          revision: `${current.revision}-revoked`,
        };
        rows.set(key, stored);
        return { status: 'updated' as const, stored };
      }),
    };
    const handler = new TestPermissionHandler(session as any, { mediationRecordStore: recordStore });
    await hydrationListStarted.promise;

    const requestId = 'new-response-during-stale-hydration';
    const input = { command: ['bash', '-lc', 'echo new response'] };
    const pending = handler.request(requestId, 'Bash', input, {
      causalPermissionContext: {
        turnId: `turn-${requestId}`,
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'default',
          sourceAuthority,
        },
      },
    });
    const remote = handler.respondToMediatedPendingPermission({
      sessionId: session.sessionId,
      turnId: `turn-${requestId}`,
      requestId,
      sourceRef: sourceAuthority.sourceRef,
      sourceRevisionOrEpoch: sourceAuthority.sourceRevisionOrEpoch,
      idempotencyKey: 'new-response-during-stale-hydration-key',
      actor: { namespace: 'discord', principalId: 'person-1' },
      decision: 'allow',
      scope: 'request',
      mediator: { pluginId: 'happier.channels', contributionLocalId: 'discord' },
    });
    let state: 'pending' | 'fulfilled' | 'rejected' = 'pending';

    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      releaseHydrationList.resolve();

      state = await settledState(remote);
      expect(state).toBe('fulfilled');
      if (state !== 'fulfilled') return;

      await expect(remote).resolves.toEqual(expect.objectContaining({ status: 'applied' }));
      await expect(pending).resolves.toEqual({ decision: 'approved' });
      expect(rows.get(identityKey(staleGrant.identity))).toEqual(expect.objectContaining({
        kind: 'remote_grant.v1',
        record: expect.objectContaining({ revoked: expect.any(Object) }),
      }));
    } finally {
      releaseHydrationList.resolve();
      await handler.reset();
      if (state === 'fulfilled') await Promise.allSettled([remote, pending]);
    }
  });

  it('does not hold an exact retry completion claim while startup hydration needs that request to reconcile', async () => {
    const session = new FakeSession();
    const requestId = 'retry-hydration-claim-race';
    const baseGrant = activeRemoteMediationGrant(10);
    if (baseGrant.kind !== 'remote_grant.v1') throw new Error('Expected remote grant fixture');
    if (baseGrant.record.effect.kind !== 'sessionGrant') throw new Error('Expected session grant effect');
    const stored: PermissionMediationStoredRecord = {
      ...baseGrant,
      identity: {
        ...baseGrant.identity,
        turnId: `turn-${requestId}`,
        requestId,
      },
      record: {
        ...baseGrant.record,
        turnId: `turn-${requestId}`,
        requestId,
        idempotencyKey: 'retry-hydration-claim-race-key',
        effect: {
          ...baseGrant.record.effect,
          grantId: 'retry-hydration-claim-race-grant',
        },
      },
    };
    const sourceAuthority = stored.record.sourceAuthority;
    session.agentState.requests[requestId] = {
      tool: 'Bash',
      kind: 'permission',
      arguments: { command: ['bash', '-lc', 'echo retry hydration'] },
      createdAt: 1,
      turnId: stored.identity.turnId,
      owner: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        sourceAuthority,
      },
      permissionResponseClaimV1: {
        version: 1,
        origin: 'remoteMediation',
        actor: stored.record.actor,
        mediatorPluginId: stored.record.mediatorPluginId,
        turnId: stored.identity.turnId,
        sourceRef: sourceAuthority.sourceRef,
        sourceRevisionOrEpoch: sourceAuthority.sourceRevisionOrEpoch,
        idempotencyKey: stored.record.idempotencyKey,
        decision: stored.record.decision,
        scope: stored.record.requestedScope,
      },
    };
    const listStarted = createDeferred<void>();
    const releaseList = createDeferred<void>();
    const retryReadStarted = createDeferred<void>();
    const releaseRetryRead = createDeferred<void>();
    let holdFirstList = true;
    let holdRetryRead = true;
    const recordStore: PermissionMediationRecordStore = {
      read: vi.fn(async () => {
        if (holdRetryRead) {
          holdRetryRead = false;
          retryReadStarted.resolve();
          await releaseRetryRead.promise;
        }
        return { status: 'found' as const, stored };
      }),
      createExpectedAbsent: vi.fn(async () => ({ status: 'conflict' as const })),
      list: vi.fn(async () => {
        if (holdFirstList) {
          holdFirstList = false;
          listStarted.resolve();
          await releaseList.promise;
        }
        return {
          status: 'ready' as const,
          records: [stored],
          nextCursor: null,
          hasNext: false,
        };
      }),
      pruneInactive: vi.fn(async () => ({ status: 'unavailable' as const })),
      compareAndSet: vi.fn(async () => ({ status: 'unavailable' as const })),
    };
    const handler = new TestPermissionHandler(session as any, { mediationRecordStore: recordStore });
    let retry: Promise<unknown> | null = null;
    let state: 'pending' | 'fulfilled' | 'rejected' = 'pending';

    try {
      await listStarted.promise;
      retry = handler.respondToMediatedPendingPermission({
        sessionId: session.sessionId,
        turnId: `turn-${requestId}`,
        requestId,
        sourceRef: sourceAuthority.sourceRef,
        sourceRevisionOrEpoch: sourceAuthority.sourceRevisionOrEpoch,
        idempotencyKey: stored.record.idempotencyKey,
        actor: {
          namespace: stored.record.actor.namespace,
          principalId: stored.record.actor.principalId,
        },
        decision: stored.record.decision,
        scope: stored.record.requestedScope,
        mediator: {
          pluginId: stored.record.actor.assertedBy.pluginId,
          contributionLocalId: stored.record.actor.assertedBy.contributionLocalId,
        },
      });
      if (!retry) throw new Error('Expected exact retry to start');
      await retryReadStarted.promise;
      releaseRetryRead.resolve();
      await Promise.resolve();
      await Promise.resolve();
      releaseList.resolve();

      state = await settledState(retry);
      expect(state).toBe('fulfilled');
      if (state !== 'fulfilled') return;

      await expect(retry).resolves.toEqual(expect.objectContaining({
        status: 'alreadyApplied',
        requestId,
        decision: 'allow',
        effect: expect.objectContaining({
          kind: 'sessionGrant',
          grantId: 'retry-hydration-claim-race-grant',
        }),
      }));
      expect(session.agentState.requests[requestId]).toBeUndefined();
    } finally {
      releaseList.resolve();
      releaseRetryRead.resolve();
      await handler.reset();
      if (state === 'fulfilled' && retry) await Promise.allSettled([retry]);
    }
  });

  it('reconciles a matching committed remote grant and claim during startup exactly once without a remote retry', async () => {
    const session = new FakeSession();
    let stored: PermissionMediationStoredRecord | null = null;
    const recordStore: PermissionMediationRecordStore = {
      read: vi.fn(async () => (
        stored ? { status: 'found' as const, stored } : { status: 'absent' as const }
      )),
      createExpectedAbsent: vi.fn(async (input) => {
        if (stored) return { status: 'conflict' as const };
        stored = { identity: input.identity, kind: input.kind, record: input.record, revision: 'ssr1.AAAACHNldHRsZW1lbnQtNAAAAAE' };
        return { status: 'created' as const, stored };
      }),
      list: vi.fn(async () => ({
        status: 'ready' as const,
        records: stored ? [stored] : [],
        nextCursor: null,
        hasNext: false,
      })),
      pruneInactive: vi.fn(async () => ({ status: 'unavailable' as const })),
      compareAndSet: vi.fn(async () => ({ status: 'unavailable' as const })),
    };
    const sourceAuthority = {
      kind: 'mediatedExternal',
      mediatorPluginId: 'happier.channels',
      sourceRef: 'binding:ops',
      sourceRevisionOrEpoch: '42',
      admittedPermissionCeiling: 'default',
      remoteApprovalMaxScope: 'session',
    } as const;
    const input = { command: ['bash', '-lc', 'echo grant after terminal failure'] };
    const handler = new TestPermissionHandler(session as any, {
      mediationRecordStore: recordStore,
      isMediatorPluginCurrent: () => true,
    } as any);
    let reloadedHandler: TestPermissionHandler | null = null;
    const pending = handler.request('grant-after-terminal-failure', 'Bash', input, {
      causalPermissionContext: {
        turnId: 'turn-grant-after-terminal-failure',
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'default',
          sourceAuthority,
        },
      },
    });
    void pending.catch(() => undefined);
    const response = {
      sessionId: session.sessionId,
      turnId: 'turn-grant-after-terminal-failure',
      requestId: 'grant-after-terminal-failure',
      sourceRef: 'binding:ops',
      sourceRevisionOrEpoch: '42',
      idempotencyKey: 'grant-after-terminal-failure-retry',
      actor: { namespace: 'discord', principalId: 'person-1' },
      decision: 'allow' as const,
      scope: 'session' as const,
      mediator: { pluginId: 'happier.channels', contributionLocalId: 'discord' },
    };
    let failTerminalWrite = true;
    let terminalCompletionWrites = 0;
    session.updateAgentState = (updater: any) => {
      const previous = session.agentState;
      const next = updater(previous);
      if (failTerminalWrite && next.completedRequests['grant-after-terminal-failure']) {
        throw new Error('terminal AgentState write failed');
      }
      if (
        !previous.completedRequests['grant-after-terminal-failure']
        && next.completedRequests['grant-after-terminal-failure']
      ) {
        terminalCompletionWrites += 1;
      }
      session.agentState = next;
      return session.agentState;
    };

    try {
      await expect(handler.respondToMediatedPendingPermission(response)).rejects.toThrow('terminal AgentState write failed');
      expect(stored).toMatchObject({ kind: 'remote_grant.v1' });
      expect(session.agentState.requests['grant-after-terminal-failure']).toBeDefined();
      expect(session.agentState.completedRequests['grant-after-terminal-failure']).toBeUndefined();
      expect(handler.isAllowedByRemoteGrant('Bash', input, sourceAuthority)).toBe(false);

      failTerminalWrite = false;
      reloadedHandler = new TestPermissionHandler(session as any, {
        mediationRecordStore: recordStore,
        isMediatorPluginCurrent: () => true,
      } as any);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(session.agentState.completedRequests['grant-after-terminal-failure']).toEqual(expect.objectContaining({
        status: 'approved',
        decision: 'approved',
        remoteMediationSettlementId: expect.any(String),
      }));
      expect(reloadedHandler.isAllowedByRemoteGrant('Bash', input, sourceAuthority)).toBe(true);
      expect(terminalCompletionWrites).toBe(1);
      expect(recordStore.createExpectedAbsent).toHaveBeenCalledTimes(1);
    } finally {
      failTerminalWrite = false;
      session.updateAgentState = (updater: any) => {
        session.agentState = updater(session.agentState);
        return session.agentState;
      };
      await reloadedHandler?.reset();
      await handler.reset();
    }
  });

  it('does not let a committed remote row without its durable claim complete or activate after restart', async () => {
    const session = new FakeSession();
    const requestId = 'unclaimed-remote-grant';
    const input = { command: ['bash', '-lc', 'echo inert remote row'] };
    const baseGrant = activeRemoteMediationGrant(7);
    if (baseGrant.kind !== 'remote_grant.v1') throw new Error('Expected remote grant fixture');
    if (baseGrant.record.effect.kind !== 'sessionGrant') throw new Error('Expected session grant fixture');
    const stored: PermissionMediationStoredRecord = {
      ...baseGrant,
      identity: {
        ...baseGrant.identity,
        turnId: `turn-${requestId}`,
        requestId,
      },
      record: {
        ...baseGrant.record,
        turnId: `turn-${requestId}`,
        requestId,
        effect: {
          kind: 'sessionGrant',
          grantId: baseGrant.record.effect.grantId,
          rule: { kind: 'exactTool', identifier: 'Bash' },
        },
      },
    };
    const sourceAuthority = stored.record.sourceAuthority;
    session.agentState.requests[requestId] = {
      tool: 'Bash',
      kind: 'permission',
      arguments: input,
      createdAt: 1,
      turnId: stored.identity.turnId,
      owner: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        sourceAuthority,
      },
    };
    const recordStore: PermissionMediationRecordStore = {
      read: vi.fn(async () => ({ status: 'found' as const, stored })),
      createExpectedAbsent: vi.fn(async () => ({ status: 'conflict' as const })),
      list: vi.fn(async () => ({
        status: 'ready' as const,
        records: [stored],
        nextCursor: null,
        hasNext: false,
      })),
      pruneInactive: vi.fn(async () => ({ status: 'unavailable' as const })),
      compareAndSet: vi.fn(async () => ({ status: 'unavailable' as const })),
    };
    const handler = new TestPermissionHandler(session as any, {
      mediationRecordStore: recordStore,
      isMediatorPluginCurrent: () => true,
    } as any);

    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(handler.listMediatedPendingRequests({
        mediatorPluginId: sourceAuthority.mediatorPluginId,
        sourceRef: sourceAuthority.sourceRef,
        sourceRevisionOrEpoch: sourceAuthority.sourceRevisionOrEpoch,
      })).toEqual({ requests: [], truncated: false });
      const response = {
        sessionId: session.sessionId,
        turnId: `turn-${requestId}`,
        sourceRef: sourceAuthority.sourceRef,
        sourceRevisionOrEpoch: sourceAuthority.sourceRevisionOrEpoch,
        idempotencyKey: 'unclaimed-restart-retry',
        actor: { namespace: 'discord', principalId: 'person-1' },
        decision: 'allow' as const,
        scope: 'session' as const,
        mediator: { pluginId: 'happier.channels', contributionLocalId: 'discord' },
      };
      await expect(handler.respondToMediatedPendingPermission({
        ...response,
        requestId,
      })).resolves.toEqual({ status: 'rejected', code: 'requestNotFound' });
      await expect(handler.respondToMediatedPendingPermission({
        ...response,
        requestId: 'unrelated-unclaimed-request',
      })).resolves.toEqual({ status: 'rejected', code: 'requestNotFound' });
      expect(session.permissionResponseClaimWriteCount).toBe(0);
      expect(recordStore.createExpectedAbsent).not.toHaveBeenCalled();
      expect(session.agentState.requests[requestId]).toBeDefined();
      expect(session.agentState.completedRequests[requestId]).toBeUndefined();
      expect(handler.isAllowedByRemoteGrant('Bash', input, sourceAuthority)).toBe(false);
    } finally {
      await handler.reset();
    }
  });

  it('rejects a foreign claimed remote response before the durable claim or record can change', async () => {
    const session = new FakeSession();
    const requestId = 'foreign-claimed-remote-response';
    const sourceAuthority = {
      kind: 'mediatedExternal',
      mediatorPluginId: 'happier.channels',
      sourceRef: 'binding:source-a',
      sourceRevisionOrEpoch: '42',
      admittedPermissionCeiling: 'default',
      remoteApprovalMaxScope: 'request',
    } as const;
    const claim = {
      version: 1,
      origin: 'remoteMediation',
      actor: {
        kind: 'externalHuman',
        assurance: 'pluginAsserted',
        namespace: 'discord',
        principalId: 'person-a',
        assertedBy: { pluginId: 'happier.channels', contributionLocalId: 'discord' },
      },
      mediatorPluginId: 'happier.channels',
      turnId: `turn-${requestId}`,
      sourceRef: 'binding:source-a',
      sourceRevisionOrEpoch: '42',
      idempotencyKey: 'source-a-key',
      decision: 'allow',
      scope: 'request',
    } as const;
    session.agentState.requests[requestId] = {
      tool: 'Bash',
      kind: 'permission',
      arguments: { command: ['bash', '-lc', 'echo source-a'] },
      createdAt: 1,
      turnId: `turn-${requestId}`,
      owner: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        sourceAuthority,
      },
      permissionResponseClaimV1: claim,
    };
    const recordStore: PermissionMediationRecordStore = {
      read: vi.fn(async () => ({ status: 'absent' as const })),
      createExpectedAbsent: vi.fn(async () => ({ status: 'conflict' as const })),
      list: vi.fn(async () => ({ status: 'ready' as const, records: [], nextCursor: null, hasNext: false })),
      pruneInactive: vi.fn(async () => ({ status: 'unavailable' as const })),
      compareAndSet: vi.fn(async () => ({ status: 'unavailable' as const })),
    };
    const handler = new TestPermissionHandler(session as any, { mediationRecordStore: recordStore });

    try {
      await expect(handler.respondToMediatedPendingPermission({
        sessionId: session.sessionId,
        turnId: `turn-${requestId}`,
        requestId,
        sourceRef: 'binding:source-b',
        sourceRevisionOrEpoch: '42',
        idempotencyKey: 'source-b-key',
        actor: { namespace: 'discord', principalId: 'person-b' },
        decision: 'allow',
        scope: 'request',
        mediator: { pluginId: 'other.mediator', contributionLocalId: 'other' },
      })).resolves.toEqual({ status: 'rejected', code: 'requestNotFound' });
      expect(session.permissionResponseClaimWriteCount).toBe(0);
      expect(session.agentState.requests[requestId]?.permissionResponseClaimV1).toEqual(claim);
      expect(session.agentState.completedRequests[requestId]).toBeUndefined();
      expect(recordStore.createExpectedAbsent).not.toHaveBeenCalled();
    } finally {
      await handler.reset();
    }
  });

  it('settles a revoked remote grant with its exact durable claim non-authorizing during startup reconciliation', async () => {
    const session = new FakeSession();
    const requestId = 'revoked-remote-grant-restart';
    const input = { command: ['bash', '-lc', 'echo revoked restart'] };
    const baseGrant = activeRemoteMediationGrant(8);
    if (baseGrant.kind !== 'remote_grant.v1') throw new Error('Expected remote grant fixture');
    if (baseGrant.record.effect.kind !== 'sessionGrant') throw new Error('Expected session grant fixture');
    const stored: PermissionMediationStoredRecord = {
      ...baseGrant,
      identity: {
        ...baseGrant.identity,
        turnId: `turn-${requestId}`,
        requestId,
      },
      record: {
        ...baseGrant.record,
        turnId: `turn-${requestId}`,
        requestId,
        idempotencyKey: 'revoked-remote-grant-restart-key',
        effect: {
          kind: 'sessionGrant',
          grantId: 'revoked-remote-grant-restart-grant',
          rule: { kind: 'exactTool', identifier: 'Bash' },
        },
        revoked: {
          atMs: 1,
          actor: { kind: 'accountUser', accountId: 'account-owner' },
        },
      },
    };
    const sourceAuthority = stored.record.sourceAuthority;
    session.agentState.requests[requestId] = {
      tool: 'Bash',
      kind: 'permission',
      arguments: input,
      createdAt: 1,
      turnId: stored.identity.turnId,
      owner: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        sourceAuthority,
      },
      permissionResponseClaimV1: {
        version: 1,
        origin: 'remoteMediation',
        actor: stored.record.actor,
        mediatorPluginId: stored.record.mediatorPluginId,
        turnId: stored.identity.turnId,
        sourceRef: sourceAuthority.sourceRef,
        sourceRevisionOrEpoch: sourceAuthority.sourceRevisionOrEpoch,
        idempotencyKey: stored.record.idempotencyKey,
        decision: stored.record.decision,
        scope: stored.record.requestedScope,
      },
    };
    const recordStore: PermissionMediationRecordStore = {
      read: vi.fn(async () => ({ status: 'found' as const, stored })),
      createExpectedAbsent: vi.fn(async () => ({ status: 'conflict' as const })),
      list: vi.fn(async () => ({
        status: 'ready' as const,
        records: [stored],
        nextCursor: null,
        hasNext: false,
      })),
      pruneInactive: vi.fn(async () => ({ status: 'unavailable' as const })),
      compareAndSet: vi.fn(async () => ({ status: 'unavailable' as const })),
    };
    const handler = new TestPermissionHandler(session as any, {
      mediationRecordStore: recordStore,
      isMediatorPluginCurrent: () => true,
    } as any);

    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(session.agentState.requests[requestId]).toBeUndefined();
      expect(session.agentState.completedRequests[requestId]).toEqual(expect.objectContaining({
        status: 'denied',
        decision: 'denied',
        remoteMediationSettlementId: stored.record.settlementId,
      }));
      expect(handler.isAllowedByRemoteGrant('Bash', input, sourceAuthority)).toBe(false);
    } finally {
      await handler.reset();
    }
  });

  it('continues a mediator grant list past a sparse foreign page without skipping the next canonical page', async () => {
    const session = new FakeSession();
    const foreignRows: PermissionMediationStoredRecord[] = Array.from({ length: 50 }, (_, index) => {
      const stored = activeRemoteMediationGrant(index);
      if (stored.kind !== 'remote_grant.v1') throw new Error('Expected remote grant fixture');
      return {
        identity: stored.identity,
        kind: 'remote_grant.v1' as const,
        record: {
          ...stored.record,
          mediatorPluginId: 'other.mediator',
          sourceAuthority: {
            ...stored.record.sourceAuthority,
            mediatorPluginId: 'other.mediator',
          },
          actor: {
            ...stored.record.actor,
            assertedBy: {
              ...stored.record.actor.assertedBy,
              pluginId: 'other.mediator',
            },
          },
        },
        revision: stored.revision,
      };
    });
    const ownGrant = activeRemoteMediationGrant(50);
    const rows = [...foreignRows, ownGrant];
    const list = vi.fn(async ({ cursor, limit = 500 }: { cursor?: string | null; limit?: number }) => {
      const start = cursor ? Number(cursor) : 0;
      const records = rows.slice(start, start + limit);
      const next = start + records.length;
      return {
        status: 'ready' as const,
        records,
        nextCursor: next < rows.length ? String(next) : null,
        hasNext: next < rows.length,
      };
    });
    const recordStore: PermissionMediationRecordStore = {
      read: vi.fn(async () => ({ status: 'unavailable' as const })),
      createExpectedAbsent: vi.fn(async () => ({ status: 'unavailable' as const })),
      list,
      pruneInactive: vi.fn(async () => ({ status: 'unavailable' as const })),
      compareAndSet: vi.fn(async () => ({ status: 'unavailable' as const })),
    };
    const handler = new TestPermissionHandler(session as any, { mediationRecordStore: recordStore });

    const result = await handler.listMediatedPermissionGrants({
      viewer: { kind: 'mediatorPlugin', pluginId: 'happier.channels' },
      limit: 50,
    });

    expect(result).toEqual({
      grants: [expect.objectContaining({
        requestId: ownGrant.record.requestId,
        grantId: ownGrant.record.effect.kind === 'sessionGrant' ? ownGrant.record.effect.grantId : '',
        projection: { kind: 'mediator' },
      })],
      nextCursor: null,
    });
    expect(list.mock.calls.filter(([params]) => params.limit === 50)).toEqual([
      [{ limit: 50 }],
      [{ cursor: '50', limit: 50 }],
    ]);
  });

  it('reselects and prunes the oldest inactive mediation row by exact revision before committing row 1,025', async () => {
    const session = new FakeSession();
    let rows = Array.from({ length: 1_024 }, (_, index) => inactiveRemoteMediationRecord(index));
    let firstPruneConflicts = true;
    const recordStore: PermissionMediationRecordStore = {
      read: vi.fn(async ({ identity }) => {
        const stored = rows.find((row) => (
          row.identity.sessionId === identity.sessionId
          && row.identity.turnId === identity.turnId
          && row.identity.requestId === identity.requestId
        ));
        return stored ? { status: 'found' as const, stored } : { status: 'absent' as const };
      }),
      createExpectedAbsent: vi.fn(async (input) => {
        if (rows.some((row) => (
          row.identity.sessionId === input.identity.sessionId
          && row.identity.turnId === input.identity.turnId
          && row.identity.requestId === input.identity.requestId
        ))) {
          return { status: 'conflict' as const };
        }
        const stored: PermissionMediationStoredRecord = {
          identity: input.identity,
          kind: input.kind,
          record: input.record,
          revision: 'ssr1.new-retained-row',
        };
        rows = [...rows, stored];
        return { status: 'created' as const, stored };
      }),
      list: vi.fn(async ({ cursor, limit = 500 }) => {
        const start = cursor ? Number(cursor) : 0;
        const records = rows.slice(start, start + limit);
        const next = start + records.length;
        return {
          status: 'ready' as const,
          records,
          nextCursor: next < rows.length ? String(next) : null,
          hasNext: next < rows.length,
        };
      }),
      compareAndSet: vi.fn(async () => ({ status: 'unavailable' as const })),
      pruneInactive: vi.fn(async ({ identity, expectedRevision }) => {
        const index = rows.findIndex((row) => (
          row.identity.sessionId === identity.sessionId
          && row.identity.turnId === identity.turnId
          && row.identity.requestId === identity.requestId
          && row.revision === expectedRevision
        ));
        if (index < 0) return { status: 'conflict' as const };
        if (firstPruneConflicts) {
          firstPruneConflicts = false;
          rows = rows.map((row, rowIndex) => (
            rowIndex === index ? { ...row, revision: 'ssr1.retained0-current' } : row
          ));
          return { status: 'conflict' as const };
        }
        rows = [...rows.slice(0, index), ...rows.slice(index + 1)];
        return { status: 'pruned' as const };
      }),
    };
    const handler = new TestPermissionHandler(session as any, { mediationRecordStore: recordStore });
    const sourceAuthority = {
      kind: 'mediatedExternal',
      mediatorPluginId: 'happier.channels',
      sourceRef: 'binding:ops',
      sourceRevisionOrEpoch: '42',
      admittedPermissionCeiling: 'default',
      remoteApprovalMaxScope: 'request',
    } as const;
    const pending = handler.request('row-1025', 'Bash', { command: ['bash', '-lc', 'echo prune'] }, {
      causalPermissionContext: {
        turnId: 'turn-row-1025',
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'default',
          sourceAuthority,
        },
      },
    });

    try {
      await expect(handler.respondToMediatedPendingPermission({
        sessionId: session.sessionId,
        turnId: 'turn-row-1025',
        requestId: 'row-1025',
        sourceRef: 'binding:ops',
        sourceRevisionOrEpoch: '42',
        idempotencyKey: 'row-1025-retry',
        actor: { namespace: 'discord', principalId: 'person-new' },
        decision: 'allow',
        scope: 'request',
        mediator: { pluginId: 'happier.channels', contributionLocalId: 'discord' },
      })).resolves.toEqual(expect.objectContaining({ status: 'applied', requestId: 'row-1025' }));
      expect(recordStore.pruneInactive).toHaveBeenNthCalledWith(1, {
        identity: {
          sessionId: session.sessionId,
          turnId: 'turn-retained-0000',
          requestId: 'retained-0000',
        },
        expectedRevision: 'ssr1.retained0',
      });
      expect(recordStore.pruneInactive).toHaveBeenNthCalledWith(2, {
        identity: {
          sessionId: session.sessionId,
          turnId: 'turn-retained-0000',
          requestId: 'retained-0000',
        },
        expectedRevision: 'ssr1.retained0-current',
      });
      expect(rows).toHaveLength(1_024);
      expect(rows.some((row) => row.record.requestId === 'retained-0000')).toBe(false);
      expect(rows.some((row) => row.record.requestId === 'row-1025')).toBe(true);
      await expect(pending).resolves.toEqual({ decision: 'approved' });
    } finally {
      await handler.reset();
      await Promise.allSettled([pending]);
    }
  });

  it('fails closed and leaves the pending request live when a full ledger contains only active grants', async () => {
    const session = new FakeSession();
    const rows = Array.from({ length: 1_024 }, (_, index) => activeRemoteMediationGrant(index));
    const recordStore: PermissionMediationRecordStore = {
      read: vi.fn(async () => ({ status: 'absent' as const })),
      createExpectedAbsent: vi.fn(async () => ({ status: 'unavailable' as const })),
      list: vi.fn(async ({ cursor, limit = 500 }) => {
        const start = cursor ? Number(cursor) : 0;
        const records = rows.slice(start, start + limit);
        const next = start + records.length;
        return {
          status: 'ready' as const,
          records,
          nextCursor: next < rows.length ? String(next) : null,
          hasNext: next < rows.length,
        };
      }),
      compareAndSet: vi.fn(async () => ({ status: 'unavailable' as const })),
      pruneInactive: vi.fn(async () => ({ status: 'unavailable' as const })),
    };
    const handler = new TestPermissionHandler(session as any, { mediationRecordStore: recordStore });
    const pending = handler.request('full-ledger-pending', 'Bash', { command: ['bash', '-lc', 'echo full'] }, {
      causalPermissionContext: {
        turnId: 'turn-full-ledger-pending',
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'default',
          sourceAuthority: {
            kind: 'mediatedExternal',
            mediatorPluginId: 'happier.channels',
            sourceRef: 'binding:ops',
            sourceRevisionOrEpoch: '42',
            admittedPermissionCeiling: 'default',
            remoteApprovalMaxScope: 'request',
          },
        },
      },
    });

    try {
      await expect(handler.respondToMediatedPendingPermission({
        sessionId: session.sessionId,
        turnId: 'turn-full-ledger-pending',
        requestId: 'full-ledger-pending',
        sourceRef: 'binding:ops',
        sourceRevisionOrEpoch: '42',
        idempotencyKey: 'full-ledger-retry',
        actor: { namespace: 'discord', principalId: 'person-new' },
        decision: 'allow',
        scope: 'request',
        mediator: { pluginId: 'happier.channels', contributionLocalId: 'discord' },
      })).resolves.toEqual({ status: 'rejected', code: 'mediationStateUnavailable' });
      expect(recordStore.pruneInactive).not.toHaveBeenCalled();
      expect(recordStore.createExpectedAbsent).not.toHaveBeenCalled();
      expect(await settledState(pending)).toBe('pending');
    } finally {
      await handler.reset();
      await expect(pending).rejects.toThrow('Session reset');
    }
  });

  it('fails closed after a second inactive-row revision conflict', async () => {
    const session = new FakeSession();
    const rows = Array.from({ length: 1_024 }, (_, index) => inactiveRemoteMediationRecord(index));
    const recordStore: PermissionMediationRecordStore = {
      read: vi.fn(async () => ({ status: 'absent' as const })),
      createExpectedAbsent: vi.fn(async () => ({ status: 'unavailable' as const })),
      list: vi.fn(async ({ cursor, limit = 500 }) => {
        const start = cursor ? Number(cursor) : 0;
        const records = rows.slice(start, start + limit);
        const next = start + records.length;
        return {
          status: 'ready' as const,
          records,
          nextCursor: next < rows.length ? String(next) : null,
          hasNext: next < rows.length,
        };
      }),
      pruneInactive: vi.fn(async () => ({ status: 'conflict' as const })),
      compareAndSet: vi.fn(async () => ({ status: 'unavailable' as const })),
    };
    const handler = new TestPermissionHandler(session as any, { mediationRecordStore: recordStore });
    const pending = handler.request('second-prune-conflict', 'Bash', { command: ['bash', '-lc', 'echo conflict'] }, {
      causalPermissionContext: {
        turnId: 'turn-second-prune-conflict',
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'default',
          sourceAuthority: {
            kind: 'mediatedExternal',
            mediatorPluginId: 'happier.channels',
            sourceRef: 'binding:ops',
            sourceRevisionOrEpoch: '42',
            admittedPermissionCeiling: 'default',
            remoteApprovalMaxScope: 'request',
          },
        },
      },
    });

    try {
      await expect(handler.respondToMediatedPendingPermission({
        sessionId: session.sessionId,
        turnId: 'turn-second-prune-conflict',
        requestId: 'second-prune-conflict',
        sourceRef: 'binding:ops',
        sourceRevisionOrEpoch: '42',
        idempotencyKey: 'second-prune-conflict-retry',
        actor: { namespace: 'discord', principalId: 'person-new' },
        decision: 'allow',
        scope: 'request',
        mediator: { pluginId: 'happier.channels', contributionLocalId: 'discord' },
      })).resolves.toEqual({ status: 'rejected', code: 'mediationStateUnavailable' });
      expect(recordStore.pruneInactive).toHaveBeenCalledTimes(2);
      expect(recordStore.createExpectedAbsent).not.toHaveBeenCalled();
      expect(await settledState(pending)).toBe('pending');
    } finally {
      await handler.reset();
      await expect(pending).rejects.toThrow('Session reset');
    }
  });

  it('replays a stored mediated settlement across a contribution replacement before and after completion', async () => {
    const session = new FakeSession();
    let stored: PermissionMediationStoredRecord | null = null;
    const interrupted = new AbortController();
    const recordStore: PermissionMediationRecordStore = {
      read: vi.fn(async () => (
        stored ? { status: 'found' as const, stored } : { status: 'absent' as const }
      )),
      createExpectedAbsent: vi.fn(async (input) => {
        if (stored) return { status: 'conflict' as const };
        stored = { identity: input.identity, kind: input.kind, record: input.record, revision: 'ssr1.AAAACHNldHRsZW1lbnQtMgAAAAE' };
        interrupted.abort();
        return { status: 'created' as const, stored };
      }),
      list: vi.fn(async () => ({ status: 'ready' as const, records: [], nextCursor: null, hasNext: false })),
      pruneInactive: vi.fn(async () => ({ status: 'unavailable' as const })),
      compareAndSet: vi.fn(async () => ({ status: 'unavailable' as const })),
    };
    const handler = new TestPermissionHandler(session as any, {
      mediationRecordStore: recordStore,
    });
    let reloadedHandler: TestPermissionHandler | null = null;
    let afterCompletionHandler: TestPermissionHandler | null = null;
    const sourceAuthority = {
      kind: 'mediatedExternal',
      mediatorPluginId: 'happier.channels',
      sourceRef: 'binding:ops',
      sourceRevisionOrEpoch: '42',
      admittedPermissionCeiling: 'default',
      remoteApprovalMaxScope: 'request',
    } as const;
    const requestInput = { command: ['bash', '-lc', 'echo interrupted remote'] };
    const pending = handler.request('remote-settlement-retry', 'Bash', requestInput, {
      causalPermissionContext: {
        turnId: 'turn-remote-settlement-retry',
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'default',
          sourceAuthority,
        },
      },
    });
    const input = {
      sessionId: session.sessionId,
      turnId: 'turn-remote-settlement-retry',
      requestId: 'remote-settlement-retry',
      sourceRef: 'binding:ops',
      sourceRevisionOrEpoch: '42',
      idempotencyKey: 'retry-after-interruption-1',
      actor: { namespace: 'discord', principalId: 'person-1' },
      decision: 'allow' as const,
      scope: 'request' as const,
      mediator: { pluginId: 'happier.channels', contributionLocalId: 'discord' },
    };

    try {
      await expect(handler.respondToMediatedPendingPermission({
        ...input,
        signal: interrupted.signal,
      })).resolves.toEqual({ status: 'rejected', code: 'canceled' });
      expect(session.agentState.completedRequests['remote-settlement-retry']).toBeUndefined();
      expect(await settledState(pending)).toBe('pending');
      expect(session.agentState.requests['remote-settlement-retry']).toMatchObject({
        permissionResponseClaimV1: {
          origin: 'remoteMediation',
          idempotencyKey: 'retry-after-interruption-1',
        },
      });

      reloadedHandler = new TestPermissionHandler(session as any, {
        mediationRecordStore: recordStore,
      });
      const replacementContributionInput = {
        ...input,
        mediator: { ...input.mediator, contributionLocalId: 'discord-reloaded' },
      };
      await expect(reloadedHandler.respondToMediatedPendingPermission(replacementContributionInput)).resolves.toEqual(expect.objectContaining({
        status: 'alreadyApplied',
        requestId: 'remote-settlement-retry',
        decision: 'allow',
        effect: { kind: 'allowOnce' },
      }));
      expect(session.agentState.requests['remote-settlement-retry']).toBeUndefined();
      expect(session.agentState.completedRequests['remote-settlement-retry']).toEqual(expect.objectContaining({
        remoteMediationSettlementId: expect.any(String),
      }));
      expect(recordStore.createExpectedAbsent).toHaveBeenCalledTimes(1);

      afterCompletionHandler = new TestPermissionHandler(session as any, {
        mediationRecordStore: recordStore,
      });
      await expect(afterCompletionHandler.respondToMediatedPendingPermission(replacementContributionInput)).resolves.toEqual(expect.objectContaining({
        status: 'alreadyApplied',
        requestId: 'remote-settlement-retry',
        decision: 'allow',
        effect: { kind: 'allowOnce' },
      }));
      expect(recordStore.createExpectedAbsent).toHaveBeenCalledTimes(1);
    } finally {
      // The RED path leaves the old claim outstanding, which production reset
      // correctly preserves for its original responder. Remove it only so the
      // test's two handlers can tear down after asserting the retry contract.
      delete session.agentState.requests['remote-settlement-retry']?.permissionResponseClaimV1;
      await afterCompletionHandler?.reset();
      await reloadedHandler?.reset();
      await handler.reset();
      await Promise.allSettled([pending]);
    }
  });

  it('does not propagate a legacy session allowlist decision into another causally mediated request', async () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);
    const causalPermissionContext = {
      causalPermissionAuthority: {
        kind: 'admittedSessionInputV1',
        admittedPermissionCeiling: 'default',
        sourceAuthority: {
          kind: 'mediatedExternal',
          mediatorPluginId: 'happier.channels',
          sourceRef: 'binding:ops',
          sourceRevisionOrEpoch: '42',
          admittedPermissionCeiling: 'default',
          remoteApprovalMaxScope: 'request',
        },
      },
    } as const;
    const toolInput = { command: ['bash', '-lc', 'echo mediated'] };
    const first = handler.request('mediated-present-user-1', 'Bash', toolInput, { causalPermissionContext });
    const second = handler.request('mediated-present-user-2', 'Bash', toolInput, { causalPermissionContext });
    const rpc = session.rpcHandlerManager.handlers.get('session.permission.respond');
    expect(rpc).toBeDefined();

    await rpc!({
      id: 'mediated-present-user-1',
      approved: true,
      decision: 'approved_for_session',
    });

    await expect(first).resolves.toEqual({ decision: 'approved_for_session' });
    expect(await settledState(second)).toBe('pending');
    expect(session.agentState.requests['mediated-present-user-2']).toBeDefined();
    expect(session.agentState.completedRequests['mediated-present-user-2']).toBeUndefined();

    await handler.reset();
    await expect(second).rejects.toThrow('Session reset');
  });

  it('registers canonical permission response handlers while preserving the legacy alias', () => {
    const session = new FakeSession();
    new TestPermissionHandler(session as any);

    expect(session.rpcHandlerManager.handlers.get('session.permission.respond')).toBeTypeOf('function');
    expect(session.rpcHandlerManager.handlers.get('session.user_action.answer')).toBeTypeOf('function');
    expect(session.rpcHandlerManager.handlers.get('permission')).toBeTypeOf('function');
  });

  it('fails closed without a server-stamped account actor and persists the attributed actor before completion', async () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);
    const modern = session.rpcHandlerManager.rawHandlers.get('session.permission.respond');
    const legacy = session.rpcHandlerManager.rawHandlers.get('permission');
    expect(modern).toBeDefined();
    expect(legacy).toBeDefined();

    const modernPending = handler.request('modern-attributed', 'Bash', { command: ['bash', '-lc', 'echo modern'] });
    await expect(modern!({ id: 'modern-attributed', approved: true })).resolves.toEqual({
      ok: false,
      errorCode: 'permission_actor_unattributable',
      requestId: 'modern-attributed',
    });
    expect(session.agentState.requests['modern-attributed']).toBeDefined();
    expect(await settledState(modernPending)).toBe('pending');

    await expect(modern!({ id: 'modern-attributed', approved: true }, serverStampedPermissionContext({
      kind: 'externalHuman',
      assurance: 'pluginAsserted',
      namespace: 'channels',
      principalId: 'person-1',
      assertedBy: { pluginId: 'happier.channels', contributionLocalId: 'telegram' },
    }))).resolves.toEqual({
      ok: false,
      errorCode: 'permission_actor_unattributable',
      requestId: 'modern-attributed',
    });
    expect(session.agentState.requests['modern-attributed']).toBeDefined();

    await expect(modern!({ id: 'modern-attributed', approved: true }, serverStampedPermissionContext())).resolves.toBeUndefined();
    await expect(modernPending).resolves.toEqual({ decision: 'approved' });
    expect(session.agentState.completedRequests['modern-attributed']).toEqual(expect.objectContaining({
      permissionDecisionActorV1: {
        kind: 'accountUser',
        accountId: 'account-owner',
        relationship: 'owner',
      },
    }));

    const legacyPending = handler.request('legacy-attributed', 'Bash', { command: ['bash', '-lc', 'echo legacy'] });
    await expect(legacy!({ id: 'legacy-attributed', approved: true })).resolves.toEqual({
      ok: false,
      errorCode: 'permission_actor_unattributable',
      requestId: 'legacy-attributed',
    });
    await expect(legacy!({ id: 'legacy-attributed', approved: true }, serverStampedPermissionContext({
      kind: 'accountUser',
      accountId: 'shared-user',
      relationship: 'sharedApprover',
    }))).resolves.toBeUndefined();
    await expect(legacyPending).resolves.toEqual({ decision: 'approved' });
    expect(session.agentState.completedRequests['legacy-attributed']).toEqual(expect.objectContaining({
      permissionDecisionActorV1: {
        kind: 'accountUser',
        accountId: 'shared-user',
        relationship: 'sharedApprover',
      },
    }));
  });

  it('rejoins an exact present-user retry from completed Agent State and rejects a different actor, decision, or scope', async () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);
    const firstRpc = session.rpcHandlerManager.rawHandlers.get('session.permission.respond');
    expect(firstRpc).toBeDefined();

    const pending = handler.request('present-completed-retry', 'Bash', { command: ['bash', '-lc', 'echo retry'] });
    const owner = {
      kind: 'accountUser',
      accountId: 'account-owner',
      relationship: 'owner',
    } as const;
    await expect(firstRpc!({
      id: 'present-completed-retry',
      approved: true,
      decision: 'approved',
    }, serverStampedPermissionContext(owner))).resolves.toBeUndefined();
    await expect(pending).resolves.toEqual({ decision: 'approved' });

    const reloadedHandler = new TestPermissionHandler(session as any);
    const retryRpc = session.rpcHandlerManager.rawHandlers.get('session.permission.respond');
    expect(retryRpc).toBeDefined();

    await expect(retryRpc!({
      id: 'present-completed-retry',
      approved: true,
      decision: 'approved',
    }, serverStampedPermissionContext(owner))).resolves.toBeUndefined();
    await expect(retryRpc!({
      id: 'present-completed-retry',
      approved: true,
      decision: 'approved',
    }, serverStampedPermissionContext({
      kind: 'accountUser',
      accountId: 'different-account',
      relationship: 'sharedApprover',
    }))).resolves.toEqual({
      ok: false,
      errorCode: 'permission_request_not_found',
      requestId: 'present-completed-retry',
    });
    await expect(retryRpc!({
      id: 'present-completed-retry',
      approved: false,
      decision: 'denied',
    }, serverStampedPermissionContext(owner))).resolves.toEqual({
      ok: false,
      errorCode: 'permission_request_not_found',
      requestId: 'present-completed-retry',
    });
    await expect(retryRpc!({
      id: 'present-completed-retry',
      approved: true,
      decision: 'approved_for_session',
    }, serverStampedPermissionContext(owner))).resolves.toEqual({
      ok: false,
      errorCode: 'permission_request_not_found',
      requestId: 'present-completed-retry',
    });

    expect(session.agentState.completedRequests['present-completed-retry']).toEqual(expect.objectContaining({
      decision: 'approved',
      permissionDecisionActorV1: owner,
    }));
    await handler.reset();
    await reloadedHandler.reset();
  });

  it('does not let the user-action RPC bypass attributed permission completion', async () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);
    const userAction = session.rpcHandlerManager.handlers.get('session.user_action.answer');
    const permission = session.rpcHandlerManager.handlers.get('session.permission.respond');
    expect(userAction).toBeDefined();
    expect(permission).toBeDefined();

    const pending = handler.request('permission-route-only', 'Bash', { command: ['bash', '-lc', 'echo route'] });
    await expect(userAction!({ id: 'permission-route-only', approved: true })).resolves.toEqual({
      ok: false,
      errorCode: 'permission_request_not_found',
      requestId: 'permission-route-only',
    });
    expect(session.agentState.requests['permission-route-only']).toBeDefined();
    expect(await settledState(pending)).toBe('pending');

    await permission!({ id: 'permission-route-only', approved: true }, serverStampedPermissionContext());
    await expect(pending).resolves.toEqual({ decision: 'approved' });
  });

  it('binds the canonical request store to each active session client', () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);

    expect(session.boundAgentStateRequestStore).toEqual(expect.objectContaining({
      publishRequest: expect.any(Function),
      registerResponseTargetHandler: expect.any(Function),
    }));

    const nextSession = new FakeSession();
    handler.updateSession(nextSession as any);

    expect(nextSession.boundAgentStateRequestStore).toBe(session.boundAgentStateRequestStore);
  });

  it('records the request kind for interactive tool prompts vs permissions', async () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);

    const askPromise = handler.request('perm-ask', 'AskUserQuestion', { questions: [] });
    expect(session.agentState.requests['perm-ask']).toEqual(
      expect.objectContaining({ tool: 'AskUserQuestion', kind: 'user_action' }),
    );

    const bashPromise = handler.request('perm-bash', 'Bash', { command: ['bash', '-lc', 'echo hello'] });
    expect(session.agentState.requests['perm-bash']).toEqual(
      expect.objectContaining({ tool: 'Bash', kind: 'permission' }),
    );

    await handler.reset();
    await expect(askPromise).rejects.toThrow('Session reset');
    await expect(bashPromise).rejects.toThrow('Session reset');
  });

  it('makes concurrent reset callers await the same active permission cleanup', async () => {
    const session = new DeferredUpdateSession();
    const handler = new TestPermissionHandler(session as any);
    const pending = handler.request('perm-concurrent-reset', 'Bash', { command: ['bash', '-lc', 'echo hello'] });

    session.deferNextUpdate();
    const firstReset = handler.reset();
    const secondReset = handler.reset();
    let firstSettled = false;
    let secondSettled = false;
    void firstReset.then(() => {
      firstSettled = true;
    });
    void secondReset.then(() => {
      secondSettled = true;
    });

    expect(await settledState(pending)).toBe('pending');
    await Promise.resolve();
    await Promise.resolve();
    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);

    session.releaseDeferredUpdate();

    await expect(firstReset).resolves.toBeUndefined();
    await expect(secondReset).resolves.toBeUndefined();
    await expect(pending).rejects.toThrow('Session reset');
    expect(session.agentState.requests['perm-concurrent-reset']).toBeUndefined();
    expect(session.agentState.completedRequests['perm-concurrent-reset']).toEqual(
      expect.objectContaining({ status: 'canceled', decision: 'abort', reason: 'Session reset' }),
    );
  });

  it('finalizes agentState requests even when the pending request map is missing the entry (lifecycle mismatch)', async () => {
    const session = new FakeSession();
    // Simulate a permission prompt that exists in UI state, but the handler has lost the pending promise
    // (e.g. reconnect/race/reset). If we ignore the response, the UI can stay stuck forever.
    session.agentState.requests['perm-1'] = {
      tool: 'bash',
      arguments: { command: ['bash', '-lc', 'echo hello'] },
      createdAt: Date.now(),
    };

    const handler = new TestPermissionHandler(session as any);

    const rpc = session.rpcHandlerManager.handlers.get('session.permission.respond');
    expect(rpc).toBeDefined();

    await rpc!({ id: 'perm-1', approved: false, decision: 'denied' });

    expect(session.agentState.requests['perm-1']).toBeUndefined();
    expect(session.agentState.completedRequests['perm-1']).toEqual(
      expect.objectContaining({
        tool: 'bash',
        status: 'denied',
        decision: 'denied',
        completedAt: expect.any(Number),
      })
    );
  });

  it('derives per-session allow tools for approved_for_session even when finalizing a stale response (no pending promise)', async () => {
    const session = new FakeSession();
    const input = { command: ['bash', '-lc', 'echo hello'] };
    session.agentState.requests['perm-1'] = {
      tool: 'bash',
      arguments: input,
      createdAt: Date.now(),
    };

    const handler = new TestPermissionHandler(session as any);
    const rpc = session.rpcHandlerManager.handlers.get('session.permission.respond');
    expect(rpc).toBeDefined();

    await rpc!({ id: 'perm-1', approved: true, decision: 'approved_for_session' });

    expect(handler.isAllowed('bash', input)).toBe(true);
    expect(session.agentState.requests['perm-1']).toBeUndefined();
    expect(session.agentState.completedRequests['perm-1']).toEqual(
      expect.objectContaining({
        decision: 'approved_for_session',
        status: 'approved',
        allowedTools: ['bash(echo hello)'],
      }),
    );
  });

  it('remembers approved_for_session tool identifiers and clears them on reset', async () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);

    const input = { command: ['bash', '-lc', 'echo hello'] };
    const promise = handler.request('perm-1', 'bash', input);

    const rpc = session.rpcHandlerManager.handlers.get('session.permission.respond');
    expect(rpc).toBeDefined();
    await rpc!({ id: 'perm-1', approved: true, decision: 'approved_for_session' });

    const result = await promise;
    expect(result.decision).toBe('approved_for_session');
    expect(handler.isAllowed('bash', input)).toBe(true);

    await handler.reset();
    expect(handler.isAllowed('bash', input)).toBe(false);
  });

  it('applies updatedPermissions addRules to the allowlist (for Claude-style permission updates)', async () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);

    const input = { command: ['bash', '-lc', 'find . -maxdepth 2 -type f'] };
    const promise = handler.request('perm-1', 'Bash', input);

    const rpc = session.rpcHandlerManager.handlers.get('session.permission.respond');
    expect(rpc).toBeDefined();
    await rpc!({
      id: 'perm-1',
      approved: true,
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'Bash', ruleContent: 'find:*' }],
        },
      ],
    });

    await promise;

    expect(handler.isAllowed('Bash', { command: ['bash', '-lc', 'find . -maxdepth 1 -type f'] })).toBe(true);

    const completed = session.agentState.completedRequests['perm-1'];
    expect(completed).toBeTruthy();
    expect(completed.updatedPermissions).toBeTruthy();

    // A fresh handler instance should seed the allowlist from completedRequests.
    const handler2 = new TestPermissionHandler(session as any);
    expect(handler2.isAllowed('Bash', { command: ['bash', '-lc', 'find . -maxdepth 1 -type f'] })).toBe(true);
  });

  it('rejects allowedTools that do not authorize the exact pending request', async () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);
    const input = { command: ['bash', '-lc', 'git status'] };
    const pending = handler.request('perm-unrelated-allowed-tool', 'Bash', input);
    const rpc = session.rpcHandlerManager.handlers.get('session.permission.respond');

    await expect(rpc!({
      id: 'perm-unrelated-allowed-tool',
      approved: true,
      decision: 'approved_for_session',
      allowedTools: ['Write'],
    })).resolves.toEqual({
      ok: false,
      errorCode: 'permission_response_invalid',
      requestId: 'perm-unrelated-allowed-tool',
    });

    expect(await settledState(pending)).toBe('pending');
    expect(handler.isAllowed('Write', { file_path: '/tmp/elsewhere' })).toBe(false);
    expect(session.agentState.requests['perm-unrelated-allowed-tool']).toBeDefined();
    expect(session.agentState.completedRequests['perm-unrelated-allowed-tool']).toBeUndefined();
    await handler.reset();
    await expect(pending).rejects.toThrow('Session reset');
  });

  it('does not seed unrelated permission authority from a completed request after reload', () => {
    const session = new FakeSession();
    session.agentState.completedRequests['completed-unrelated-authority'] = {
      kind: 'permission',
      tool: 'Bash',
      arguments: { command: ['bash', '-lc', 'git status'] },
      status: 'approved',
      decision: 'approved_for_session',
      allowedTools: ['Write'],
      updatedPermissions: [{
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [{ toolName: 'Write' }],
      }],
    };

    const handler = new TestPermissionHandler(session as any);

    expect(handler.isAllowed('Write', { file_path: '/tmp/elsewhere' })).toBe(false);
    expect(handler.isAllowed('Bash', { command: ['bash', '-lc', 'git status'] })).toBe(false);
  });

  it('rejects permission updates that grant an unrelated tool', async () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);
    const input = { command: ['bash', '-lc', 'git status'] };
    const pending = handler.request('perm-unrelated-update', 'Bash', input);
    const rpc = session.rpcHandlerManager.handlers.get('session.permission.respond');

    await expect(rpc!({
      id: 'perm-unrelated-update',
      approved: true,
      updatedPermissions: [{
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [{ toolName: 'Write' }],
      }],
    })).resolves.toEqual({
      ok: false,
      errorCode: 'permission_response_invalid',
      requestId: 'perm-unrelated-update',
    });

    expect(await settledState(pending)).toBe('pending');
    expect(handler.isAllowed('Write', { file_path: '/tmp/elsewhere' })).toBe(false);
    expect(session.agentState.requests['perm-unrelated-update']).toBeDefined();
    expect(session.agentState.completedRequests['perm-unrelated-update']).toBeUndefined();
    await handler.reset();
    await expect(pending).rejects.toThrow('Session reset');
  });

  it('rejects contradictory approval and decision fields without settling the request', async () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);
    const pending = handler.request('contradictory-decision', 'Write', { file_path: '/tmp/example' });
    const rpc = session.rpcHandlerManager.handlers.get('session.permission.respond');

    await expect(rpc!({
      id: 'contradictory-decision',
      approved: true,
      decision: 'denied',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'permission_response_invalid',
      requestId: 'contradictory-decision',
    });

    expect(await settledState(pending)).toBe('pending');
    expect(session.agentState.requests['contradictory-decision']).toBeDefined();
    expect(session.agentState.completedRequests['contradictory-decision']).toBeUndefined();
    await handler.reset();
    await expect(pending).rejects.toThrow('Session reset');
  });

  it('does not let a user-action answer seed permission authority', async () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);
    const pending = handler.request('question-with-authority', 'AskUserQuestion', {
      questions: [{ question: 'Continue?', choices: ['Yes', 'No'] }],
    });
    const rpc = session.rpcHandlerManager.handlers.get('session.user_action.answer');

    await expect(rpc!({
      id: 'question-with-authority',
      approved: true,
      answers: { 'Continue?': ['Yes'] },
      updatedPermissions: [{
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [{ toolName: 'Bash' }],
      }],
    })).resolves.toEqual({
      ok: false,
      errorCode: 'permission_response_invalid',
      requestId: 'question-with-authority',
    });

    expect(await settledState(pending)).toBe('pending');
    expect(handler.isAllowed('Bash', { command: ['bash', '-lc', 'rm -rf /tmp/example'] })).toBe(false);
    expect(session.agentState.requests['question-with-authority']).toBeDefined();
    await handler.reset();
    await expect(pending).rejects.toThrow('Session reset');
  });

  it('rejects an exec-policy amendment that does not match the current pending proposal', async () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);
    const pending = handler.request('exec-policy-mismatch', 'Bash', {
      command: ['bash', '-lc', 'git status'],
      proposedExecpolicyAmendment: ['git', 'status'],
    });
    const rpc = session.rpcHandlerManager.handlers.get('session.permission.respond');

    await expect(rpc!({
      id: 'exec-policy-mismatch',
      approved: true,
      decision: 'approved_execpolicy_amendment',
      execPolicyAmendment: { command: ['git', 'push', '--force'] },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'permission_response_invalid',
      requestId: 'exec-policy-mismatch',
    });

    expect(await settledState(pending)).toBe('pending');
    expect(session.agentState.requests['exec-policy-mismatch']).toBeDefined();
    await handler.reset();
    await expect(pending).rejects.toThrow('Session reset');
  });

  it('accepts the exact current exec-policy amendment proposal', async () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);
    const pending = handler.request('exec-policy-exact', 'Bash', {
      command: ['bash', '-lc', 'git status'],
      proposedExecpolicyAmendment: ['git', 'status'],
    });
    const rpc = session.rpcHandlerManager.handlers.get('session.permission.respond');

    await expect(rpc!({
      id: 'exec-policy-exact',
      approved: true,
      decision: 'approved_execpolicy_amendment',
      execPolicyAmendment: { command: ['git', 'status'] },
    })).resolves.toBeUndefined();

    await expect(pending).resolves.toEqual({
      decision: 'approved_execpolicy_amendment',
      execPolicyAmendment: { command: ['git', 'status'] },
    });
  });

  it('auto-approves other pending permission prompts once an allowlist update makes them allowed', async () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);

    const input1 = { command: ['bash', '-lc', 'find . -maxdepth 2 -type f'] };
    const input2 = { command: ['bash', '-lc', 'find . -maxdepth 1 -type f'] };
    const p1 = handler.request('perm-1', 'Bash', input1);
    const p2 = handler.request('perm-2', 'Bash', input2);

    const rpc = session.rpcHandlerManager.handlers.get('session.permission.respond');
    expect(rpc).toBeDefined();

    await rpc!({
      id: 'perm-1',
      approved: true,
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'Bash', ruleContent: 'find:*' }],
        },
      ],
    });

    await expect(p1).resolves.toEqual(expect.objectContaining({ decision: 'approved' }));

    const raced = await Promise.race([
      p2.then(() => 'resolved' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 20)),
    ]);
    expect(raced).toBe('resolved');

    expect(session.agentState.requests['perm-2']).toBeUndefined();
    expect(session.agentState.completedRequests['perm-2']).toEqual(
      expect.objectContaining({
        tool: 'Bash',
        status: 'approved',
      }),
    );
  });

  it('ignores stale permission responses that do not match any agentState request (no allowlist updates, no auto-approvals)', async () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);

    const pendingInput = { command: ['bash', '-lc', 'find . -maxdepth 1 -type f | head -n 5'] };
    const pendingPromise = handler.request('perm-2', 'Bash', pendingInput);

    const rpc = session.rpcHandlerManager.handlers.get('session.permission.respond');
    expect(rpc).toBeDefined();

    // Response id does not exist in pendingRequests AND does not exist in agentState.requests.
    // We must fail closed: don't update allowlists and don't auto-approve unrelated prompts.
    await rpc!({
      id: 'perm-stale',
      approved: true,
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'Bash', ruleContent: 'find:*' }],
        },
      ],
    });

    expect(handler.isAllowed('Bash', pendingInput)).toBe(false);
    expect(session.agentState.completedRequests['perm-stale']).toBeUndefined();

    const raced = await Promise.race([
      pendingPromise.then(() => 'resolved' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 20)),
    ]);
    expect(raced).toBe('timeout');
    expect(session.agentState.requests['perm-2']).toBeTruthy();
  });

  it('returns structured answers for AskUserQuestion responses', async () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);

    const input = { questions: [{ question: 'q1', choices: ['a', 'b'] }] };
    const promise = handler.request('perm-ask', 'AskUserQuestion', input);

    const rpc = session.rpcHandlerManager.handlers.get('session.user_action.answer');
    expect(rpc).toBeDefined();
    await rpc!({
      id: 'perm-ask',
      approved: true,
      answers: { q1: ['a'], q2: ['Alpha, Beta', 'Gamma'] },
    });

    const result = await promise;
    expect(result.decision).toBe('approved');
    expect(result.answers).toEqual({
      q1: ['a'],
      q2: ['Alpha, Beta', 'Gamma'],
    });
  });

  it('retains the released preview scalar answer reader for old UI to new CLI skew', async () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);
    const promise = handler.request('perm-ask-legacy', 'AskUserQuestion', {
      questions: [{ question: 'q1', choices: ['a', 'b'] }],
    });

    await session.rpcHandlerManager.handlers.get('session.user_action.answer')!({
      id: 'perm-ask-legacy',
      approved: true,
      answers: { q1: 'Alpha, Beta' },
    });

    await expect(promise).resolves.toMatchObject({
      decision: 'approved',
      answers: { q1: ['Alpha, Beta'] },
    });
  });

  it('keeps a schema-invalid structured answer retryable until a valid answer arrives', async () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);
    const pending = handler.request('question-retryable', 'AskUserQuestion', {
      questions: [{ question: 'q1', options: [{ label: 'a' }] }],
    });
    const rpc = session.rpcHandlerManager.handlers.get('session.user_action.answer');

    await expect(rpc!({
      id: 'question-retryable',
      approved: true,
      answers: { q1: ['a', 'a'] },
    })).rejects.toThrow('Invalid structured question answers');
    expect(session.agentState.requests['question-retryable']).toBeDefined();
    expect(await settledState(pending)).toBe('pending');

    await rpc!({
      id: 'question-retryable',
      approved: true,
      answers: { q1: ['a'] },
    });
    await expect(pending).resolves.toEqual({
      decision: 'approved',
      answers: { q1: ['a'] },
    });
  });

  it('accepts a response only through the session handler that owns the live request', async () => {
    const ownerSession = new FakeSession();
    const owner = new TestPermissionHandler(ownerSession as any);
    const nonOwnerSession = new FakeSession();
    const nonOwner = new TestPermissionHandler(nonOwnerSession as any);
    const pending = owner.request('owned-question', 'AskUserQuestion', {
      questions: [{ question: 'q1', options: [{ label: 'a' }] }],
    });

    const nonOwnerRpc = nonOwnerSession.rpcHandlerManager.handlers.get('session.user_action.answer');
    await expect(nonOwnerRpc!({
      id: 'owned-question',
      approved: true,
      answers: { q1: ['a'] },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'permission_request_not_found',
      requestId: 'owned-question',
    });
    expect(await settledState(pending)).toBe('pending');

    const ownerRpc = ownerSession.rpcHandlerManager.handlers.get('session.user_action.answer');
    await expect(ownerRpc!({
      id: 'owned-question',
      approved: true,
      answers: { q1: ['a'] },
    })).resolves.toBeUndefined();
    await expect(pending).resolves.toEqual({
      decision: 'approved',
      answers: { q1: ['a'] },
    });
  });

  it.each(['denied', 'abort'] as const)(
    'delivers an answerless AskUserQuestion %s decision to its live waiter',
    async (decision) => {
      const session = new FakeSession();
      const handler = new TestPermissionHandler(session as any);
      const pending = handler.request(`question-${decision}`, 'AskUserQuestion', {
        questions: [{ question: 'q1', options: [{ label: 'a' }] }],
      });
      const rpc = session.rpcHandlerManager.handlers.get('session.user_action.answer');

      await rpc!({ id: `question-${decision}`, approved: false, decision });

      await expect(pending).resolves.toEqual({ decision });
      expect(session.agentState.completedRequests[`question-${decision}`]).toEqual(
        expect.objectContaining({ status: 'denied', decision }),
      );
    },
  );

  it('invokes onAbortRequested when user responds with abort', async () => {
    const session = new FakeSession();
    let aborted = false;
    const handler = new TestPermissionHandler(session as any, {
      onAbortRequested: () => {
        aborted = true;
      },
    });

    const promise = handler.request('perm-1', 'read', { filepath: '/tmp/x' });

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    expect(rpc).toBeDefined();
    await rpc!({ id: 'perm-1', approved: false, decision: 'abort' });

    const result = await promise;
    expect(result.decision).toBe('abort');
    expect(aborted).toBe(true);
    expect(session.agentState.completedRequests['perm-1']).toEqual(
      expect.objectContaining({
        status: 'denied',
        decision: 'abort',
      })
    );
  });

  it('can suppress onAbortRequested callback for abort decisions', async () => {
    const session = new FakeSession();
    let aborted = false;
    const handler = new TestPermissionHandler(session as any, {
      onAbortRequested: () => {
        aborted = true;
      },
      triggerAbortCallbackOnAbortDecision: false,
    });

    const promise = handler.request('perm-1', 'read', { filepath: '/tmp/x' });

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    expect(rpc).toBeDefined();
    await rpc!({ id: 'perm-1', approved: false, decision: 'abort' });

    const result = await promise;
    expect(result.decision).toBe('abort');
    expect(aborted).toBe(false);
  });

  it('does not auto-approve other pending requests when user responds with abort', async () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);

    // Seed a session-wide allow rule so a later pending request would be eligible for auto-approval.
    const seed = handler.request('perm-seed', 'Bash', { command: ['bash', '-lc', 'find . -maxdepth 1 -type f'] });
    const rpc = session.rpcHandlerManager.handlers.get('permission');
    expect(rpc).toBeDefined();
    await rpc!({
      id: 'perm-seed',
      approved: true,
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'Bash', ruleContent: 'find:*' }],
        },
      ],
    });
    await seed;

    const input1 = { command: ['bash', '-lc', 'find . -maxdepth 1 -type f | head -n 5'] };
    const input2 = { command: ['bash', '-lc', 'find . -maxdepth 1 -type f | head -n 5'] };

    const p1 = handler.request('perm-1', 'Bash', input1);
    const p2 = handler.request('perm-2', 'Bash', input2);

    await rpc!({ id: 'perm-1', approved: false, decision: 'abort' });
    await expect(p1).resolves.toEqual(expect.objectContaining({ decision: 'abort' }));

    const raced = await Promise.race([
      p2.then(() => 'resolved' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 20)),
    ]);
    expect(raced).toBe('timeout');
    expect(session.agentState.requests['perm-2']).toBeDefined();
  });

  it('clears the allowlist when the session reference is updated', async () => {
    const session1 = new FakeSession();
    const handler = new TestPermissionHandler(session1 as any);

    const input = { command: ['bash', '-lc', 'echo hello'] };
    const promise = handler.request('perm-1', 'bash', input);

    const rpc1 = session1.rpcHandlerManager.handlers.get('permission');
    expect(rpc1).toBeDefined();
    await rpc1!({ id: 'perm-1', approved: true, decision: 'approved_for_session' });

    await promise;
    expect(handler.isAllowed('bash', input)).toBe(true);

    const session2 = new FakeSession();
    // Simulate a new session reference without persisted allowlist entries.
    session2.agentState = { requests: {}, completedRequests: {} };
    handler.updateSession(session2 as any);

    expect(handler.isAllowed('bash', input)).toBe(false);
  });

  it('propagates durable response persistence failure without emitting unhandledRejection', async () => {
    const session = new FakeSession();
    session.updateAgentState = async () => {
      throw new Error('updateAgentState failed');
    };
    const handler = new TestPermissionHandler(session as any);

    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    const pending = handler.request('perm-1', 'bash', { command: ['bash', '-lc', 'echo hello'] });
    try {
      const rpc = session.rpcHandlerManager.handlers.get('permission');
      await expect(rpc!({ id: 'perm-1', approved: true, decision: 'approved' })).rejects.toThrow(
        'updateAgentState failed',
      );
      await expect(settledState(pending)).resolves.toBe('pending');

      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      session.updateAgentState = (updater: any) => {
        session.agentState = updater(session.agentState);
        return session.agentState;
      };
      const pendingRejected = expect(pending).rejects.toThrow('Session reset');
      await handler.reset();
      await pendingRejected;
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
