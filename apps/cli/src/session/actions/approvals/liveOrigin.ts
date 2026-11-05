import { AsyncLocalStorage } from 'node:async_hooks';
import type { ActionExecuteResult, ActionExecutorContext, ActionExecutorDeps, ApprovalRequest, TargetActionApprovalRequestV1 } from '@happier-dev/protocol';
import { targetActionApprovalSubjectsEqual } from '@happier-dev/protocol/approvals/targetActionApprovalRequestTransition';
import { TargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { isTargetApproval } from '@happier-dev/protocol/approvals/resolveApprovalExecutor';
import type { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { PUBLIC_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions/actionSpecs';
import { LIVE_CLI_APPROVAL_DECIDE_METHOD, readLiveCliApprovalOriginScope } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { ApprovalRequestConflict } from '@happier-dev/protocol/approvals/creation';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createUserScopedSocketConnection } from '@/api/session/sockets';
import { resolveSessionControlSocketConnectTimeoutMs, resolveSessionControlSocketAckTimeoutMs } from '@/session/transport/shared/sessionTimeouts';

type LiveRequest = ApprovalRequest | TargetActionApprovalRequestV1;
type Prepared = Awaited<ReturnType<ReturnType<typeof createActionExecutor>['prepare']>>;
type Origin = Readonly<{ ready(artifactId: string): void; dispose(): Promise<void> }>;
type Invocation = Readonly<{ context: ActionExecutorContext; origins: Set<Origin> }>;
type ApprovalRead = Awaited<ReturnType<NonNullable<ActionExecutorDeps['approvalsGet']>>>;

function failure(errorCode: string): ActionExecuteResult { return { ok: false, errorCode, error: errorCode }; }
function gate() {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>(done => { resolve = done; });
  return { promise, resolve };
}

/** Only the original invocation retains private operands; RPC carries a decision. */
export function createLiveCliApprovalOrigin(params: Readonly<{
  token: string; accountId: string | null; serverUrl: string;
  decide(input: unknown, context: ActionExecutorContext): Promise<ActionExecuteResult>;
}>) {
  const current = new AsyncLocalStorage<Invocation>();
  const decidingSubject = new AsyncLocalStorage<Readonly<{ artifactId: string; request: LiveRequest }>>();
  const validateRead = <Request extends ApprovalRead>(artifactId: string, request: Request): Request => {
    const original = decidingSubject.getStore();
    // Validate the existing read before candidate Action/flow classification:
    // changing either must not bypass the original live waiter's custody.
    if (original?.artifactId === artifactId && request) {
      const target = isTargetApproval(original.request) ? TargetActionApprovalRequestV1Schema.safeParse(request) : null;
      const valid = target
        ? target.success && isTargetApproval(original.request) && targetActionApprovalSubjectsEqual(original.request, target.data)
        : !isTargetApproval(original.request) && !isTargetApproval(request) && decideApprovalRequestTransition(original.request, request).ok;
      if (!valid) throw new ApprovalRequestConflict();
    }
    return request;
  };
  const dispose = async (invocation: Invocation) => {
    await Promise.all([...invocation.origins].map(origin => origin.dispose()));
  };
  const run = async <T>(context: ActionExecutorContext, execute: () => Promise<T>): Promise<T> => {
    const invocation: Invocation = { context, origins: new Set() };
    try { return await current.run(invocation, execute); }
    finally { await dispose(invocation); }
  };
  const prepare = async (context: ActionExecutorContext, execute: () => Promise<Prepared>): Promise<Prepared> => {
    const invocation: Invocation = { context, origins: new Set() };
    try {
      const result = await current.run(invocation, execute);
      if (result.kind !== 'ready') { await dispose(invocation); return result; }
      return { ...result, invocation: { ...result.invocation,
        run: () => current.run(invocation, async () => {
          try { return await result.invocation.run(); }
          finally { await dispose(invocation); }
        }),
      } };
    } catch (error) { await dispose(invocation); throw error; }
  };
  const publish = async <Result extends Readonly<{ artifactId: string }>>(args: Readonly<{ request: LiveRequest }>,
    create: () => Promise<Result>): Promise<Result> => {
    const invocation = current.getStore();
    const request = args.request;
    const originScope = readLiveCliApprovalOriginScope(request);
    if (!originScope) return await create();
    const context = invocation?.context;
    const origin = request.v === 2 || isTargetApproval(request) ? request.executionOriginV1 : undefined;
    if (!origin || !invocation || !context || context.surface !== 'cli'
      || context.actionCaller && context.actionCaller.kind !== 'host'
      || context.externalActionCredential || context.externalActionExecutionAuthorization || context.rpcSessionAuthorization
      || context.causalPermissionAuthority || context.callerInputConstraints
      || origin.accountId !== params.accountId) {
      throw Object.assign(new Error('approval_origin_unavailable'), { code: 'approval_origin_unavailable' });
    }
    context.signal?.throwIfAborted();
    const published = gate();
    const waiting = gate();
    let artifactId: string | null = null;
    let closed = false;
    const manager = new RpcHandlerManager({ scopePrefix: originScope, encryptionMode: 'plain' });
    manager.registerHandler<unknown, ActionExecuteResult>(LIVE_CLI_APPROVAL_DECIDE_METHOD, async (input, transport) => {
      if (transport?.callerAuthority !== 'present_user' || transport.authorization || transport.callerInputAuthorization
        || transport.callerInputConstraints || transport.sessionActionOrigin || transport.machineAdmission
        || transport.localActionContext) return failure('present_user_required');
      const parsed = PUBLIC_ACTION_INPUT_SCHEMAS['approval.request.decide'].safeParse(input);
      if (!parsed.success) return failure('invalid_parameters');
      if (!await published.promise || closed || parsed.data.artifactId !== artifactId
        || parsed.data.serverIdentityId !== origin.serverIdentityId || parsed.data.originServerId !== origin.serverId
        || parsed.data.decision !== 'approve') return failure('approval_stale');
      if (!await waiting.promise || closed || context.signal?.aborted) return failure('approval_origin_unavailable');
      transport.signal.throwIfAborted();
      return await decidingSubject.run({ artifactId: parsed.data.artifactId, request },
        () => params.decide(parsed.data, { ...context, authority: 'present_user' }));
    });
    const connection = createUserScopedSocketConnection({ token: params.token, serverUrl: params.serverUrl,
      connectTimeoutMs: resolveSessionControlSocketConnectTimeoutMs(), clientPurpose: 'scoped-rpc' });
    const onConnect = () => manager.onSocketConnect(connection.socket);
    const onDisconnect = () => manager.onSocketDisconnect();
    const onRequest = (packet: Parameters<typeof manager.handleRequest>[0], ack: (value: unknown) => void) => {
      void manager.handleRequest(packet).then(ack);
    };
    connection.socket.on('connect', onConnect);
    connection.socket.on('disconnect', onDisconnect);
    connection.socket.on(SOCKET_RPC_EVENTS.REQUEST, onRequest);
    let disposing: Promise<void> | undefined;
    const registration: Origin = {
      ready: id => { if (id === artifactId) waiting.resolve(true); },
      dispose: () => disposing ??= (async () => {
        closed = true; published.resolve(false); waiting.resolve(false);
        context.signal?.removeEventListener('abort', onAbort);
        manager.unregisterHandler(LIVE_CLI_APPROVAL_DECIDE_METHOD);
        try { await manager.waitForIdle(); }
        finally {
          connection.socket.off('connect', onConnect);
          connection.socket.off('disconnect', onDisconnect);
          connection.socket.off(SOCKET_RPC_EVENTS.REQUEST, onRequest);
          manager.onSocketDisconnect();
          try { await connection.transport.destroy(); } catch { /* Preserve the Action's settled result. */ }
          try { connection.socket.close(); } catch { /* Preserve the Action's settled result. */ }
          invocation.origins.delete(registration);
        }
      })(),
    };
    const onAbort = () => { void registration.dispose(); };
    invocation.origins.add(registration);
    context.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await connection.transport.connect();
      context.signal?.throwIfAborted();
      const readiness = await manager.waitForRegisteredHandlers([LIVE_CLI_APPROVAL_DECIDE_METHOD], {
        timeoutMs: resolveSessionControlSocketAckTimeoutMs(),
      });
      if (readiness.status !== 'ready' || closed || !connection.socket.connected) {
        throw Object.assign(new Error('approval_origin_unavailable'), { code: 'approval_origin_unavailable' });
      }
      const result = await create();
      artifactId = result.artifactId;
      published.resolve(true);
      return result;
    } catch (error) { await registration.dispose(); throw error; }
  };
  return { run, prepare, publish, validateRead, waiterReady: (artifactId: string) => {
    for (const origin of current.getStore()?.origins ?? []) origin.ready(artifactId);
  } };
}
