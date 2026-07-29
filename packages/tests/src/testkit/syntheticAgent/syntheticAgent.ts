import type { CapturedEvent } from '../socketClient';
import { type SocketCollector } from '../socketClient';
import { decryptDataKeyBase64, encryptDataKeyBase64 } from '../rpcCrypto';
import { fetchSessionV2, patchSessionAgentState } from '../sessions';
import { sleep, waitFor } from '../timing';
import { createMachineBoundSessionScopedSocketCollector } from '../sessionSocketBinding';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

type PermissionRequest = {
  id: string;
  tool: string;
  args: unknown;
};

type PermissionDecision = {
  id: string;
  approved: boolean;
  reason?: string;
  mode?: string;
  allowedTools?: string[];
  decision?: string;
  execPolicyAmendment?: { command: string[] };
  answers?: Record<string, string>;
};

type AgentStateShape = {
  requests?: Record<string, { tool: string; arguments: unknown; createdAt?: number | null }>;
  completedRequests?: Record<
    string,
    {
      tool: string;
      arguments: unknown;
      createdAt?: number | null;
      completedAt?: number | null;
      status: 'canceled' | 'denied' | 'approved';
      reason?: string | null;
      mode?: string | null;
      allowedTools?: string[] | null;
      decision?: string | null;
      answers?: Record<string, string> | null;
    }
  >;
};

type PendingMaterializeAck = {
  ok?: unknown;
  error?: unknown;
  didMaterialize?: unknown;
  pendingCount?: unknown;
  pendingVersion?: unknown;
};

export function computeVersionMismatchBackoffMs(attempt: number): number {
  const boundedAttempt = Math.max(1, Math.floor(attempt));
  const base = 25;
  const cap = 750;
  const exponential = Math.min(cap, base * 2 ** (boundedAttempt - 1));
  const jitter = (boundedAttempt * 17) % 31;
  return exponential + jitter;
}

export class SyntheticAgent {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly sessionId: string;
  private readonly dataKey: Uint8Array;
  private socket: SocketCollector | null = null;
  private pendingConsumerStopRequested = true;
  private pendingConsumerLoop: Promise<void> | null = null;
  private pendingConsumerFailure: Error | null = null;

  constructor(params: { baseUrl: string; token: string; sessionId: string; dataKey: Uint8Array }) {
    this.baseUrl = params.baseUrl;
    this.token = params.token;
    this.sessionId = params.sessionId;
    this.dataKey = params.dataKey;
  }

  getEvents(): CapturedEvent[] {
    return this.socket?.getEvents() ?? [];
  }

  async start(): Promise<void> {
    if (!this.socket) {
      const created = await createMachineBoundSessionScopedSocketCollector({
        baseUrl: this.baseUrl,
        token: this.token,
        sessionId: this.sessionId,
      });
      this.socket = created.socket;
    }

    const socket = this.socket;
    if (!socket) {
      throw new Error('SyntheticAgent socket initialization failed');
    }

    socket.connect();
    await waitFor(() => socket.isConnected(), { timeoutMs: 20_000 });

    const permissionMethod = `${this.sessionId}:permission`;
    const userMessageMethod = `${this.sessionId}:${SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND}`;
    socket.onRpcRequest(async (req) => {
      if (req.method === userMessageMethod) {
        const message = decryptDataKeyBase64(req.params, this.dataKey) as Record<string, unknown> | null;
        if (!message || typeof message.text !== 'string' || typeof message.localId !== 'string') {
          return encryptDataKeyBase64({ error: 'invalid-request' }, this.dataKey);
        }
        return encryptDataKeyBase64({ ok: true }, this.dataKey);
      }
      if (req.method !== permissionMethod) {
        // Return an encrypted METHOD_NOT_FOUND-like response; server also guards this.
        return encryptDataKeyBase64({ error: 'method-not-found' }, this.dataKey);
      }

      const decision = decryptDataKeyBase64(req.params, this.dataKey) as PermissionDecision | null;
      if (!decision || typeof decision.id !== 'string') {
        return encryptDataKeyBase64({ error: 'invalid-request' }, this.dataKey);
      }

      await this.applyPermissionDecision(decision);
      return encryptDataKeyBase64({ ok: true }, this.dataKey);
    });

    await socket.rpcRegister(permissionMethod);
    await socket.rpcRegister(userMessageMethod);
    socket.emit('session-alive', {
      sid: this.sessionId,
      time: Date.now(),
      thinking: false,
    });
    await waitFor(async () => {
      const session = await fetchSessionV2(this.baseUrl, this.token, this.sessionId);
      return session.active === true;
    }, { timeoutMs: 20_000, context: `synthetic agent session active (${this.sessionId})` });

    this.pendingConsumerStopRequested = false;
    this.pendingConsumerFailure = null;
    this.pendingConsumerLoop = this.runPendingConsumerLoop(socket).catch((error: unknown) => {
      if (this.pendingConsumerStopRequested) return;
      this.pendingConsumerFailure = error instanceof Error ? error : new Error(String(error));
    });
  }

  async stop(): Promise<void> {
    this.pendingConsumerStopRequested = true;
    this.socket?.close();
    await this.pendingConsumerLoop;
    this.pendingConsumerLoop = null;
  }

  assertPendingConsumerHealthy(): void {
    if (this.pendingConsumerFailure) throw this.pendingConsumerFailure;
  }

  async publishPermissionRequest(req: PermissionRequest): Promise<void> {
    const now = Date.now();
    await this.updateAgentStateWithRetry((state) => {
      const next: AgentStateShape = { ...state };
      const requests = { ...(next.requests ?? {}) };
      requests[req.id] = { tool: req.tool, arguments: req.args, createdAt: now };
      next.requests = requests;
      return next;
    });
  }

  async waitForCompletedPermission(permissionId: string, opts?: { timeoutMs?: number }): Promise<void> {
    await waitFor(async () => {
      const session = await fetchSessionV2(this.baseUrl, this.token, this.sessionId);
      const state = session.agentState ? (decryptDataKeyBase64(session.agentState, this.dataKey) as AgentStateShape | null) : null;
      const completed = state?.completedRequests ?? {};
      return Boolean(completed && completed[permissionId]);
    }, { timeoutMs: opts?.timeoutMs ?? 15_000, intervalMs: 100, context: `completed permission ${permissionId}` });
  }

  private async applyPermissionDecision(decision: PermissionDecision): Promise<void> {
    const now = Date.now();
    await this.updateAgentStateWithRetry((state) => {
      const next: AgentStateShape = { ...state };
      const existingReq = next.requests?.[decision.id];

      const requests = { ...(next.requests ?? {}) };
      delete requests[decision.id];
      next.requests = requests;

      const completedRequests = { ...(next.completedRequests ?? {}) };
      completedRequests[decision.id] = {
        tool: existingReq?.tool ?? 'Unknown',
        arguments: existingReq?.arguments ?? {},
        createdAt: existingReq?.createdAt ?? null,
        completedAt: now,
        status: decision.approved ? 'approved' : 'denied',
        reason: decision.reason ?? null,
        mode: decision.mode ?? null,
        allowedTools: decision.allowedTools ?? null,
        decision: decision.decision ?? (decision.approved ? 'approved' : 'denied'),
        answers: decision.answers ?? null,
      };
      next.completedRequests = completedRequests;
      return next;
    });
  }

  private async runPendingConsumerLoop(socket: SocketCollector): Promise<void> {
    const initialSession = await fetchSessionV2(this.baseUrl, this.token, this.sessionId);
    let shouldDrain = (initialSession.pendingCount ?? 0) > 0;
    let pendingVersion = initialSession.pendingVersion;
    let eventCursor = 0;

    while (!this.pendingConsumerStopRequested) {
      const events = socket.getEvents();
      for (const event of events.slice(eventCursor)) {
        if (event.kind !== 'update') continue;
        const body = event.payload.body;
        if (body?.t !== 'pending-changed') continue;
        if (body.sid !== this.sessionId && body.sessionId !== this.sessionId) continue;
        if (typeof body.pendingVersion === 'number' && Number.isSafeInteger(body.pendingVersion) && body.pendingVersion >= 0) {
          pendingVersion = body.pendingVersion;
        }
        if (typeof body.pendingCount === 'number' && Number.isSafeInteger(body.pendingCount) && body.pendingCount >= 0) {
          shouldDrain = body.pendingCount > 0;
        }
      }
      eventCursor = events.length;

      if (!shouldDrain || !socket.isConnected()) {
        await sleep(50);
        continue;
      }

      let ack: PendingMaterializeAck;
      try {
        ack = await socket.emitWithAck<PendingMaterializeAck>('pending-materialize-next', {
          sid: this.sessionId,
          ...(typeof pendingVersion === 'number' ? { pendingVersion } : {}),
        }, 10_000);
      } catch (error) {
        if (this.pendingConsumerStopRequested) return;
        throw error;
      }
      if (ack?.ok !== true) {
        throw new Error(`SyntheticAgent pending-materialize-next failed (${typeof ack?.error === 'string' ? ack.error : 'unknown'})`);
      }
      if (typeof ack.pendingVersion === 'number' && Number.isSafeInteger(ack.pendingVersion) && ack.pendingVersion >= 0) {
        pendingVersion = ack.pendingVersion;
      }
      if (ack.didMaterialize === true) {
        shouldDrain = typeof ack.pendingCount === 'number' ? ack.pendingCount > 0 : true;
        continue;
      }
      shouldDrain = false;
    }
  }

  private async updateAgentStateWithRetry(updater: (state: AgentStateShape) => AgentStateShape): Promise<void> {
    const attempts = 10;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const session = await fetchSessionV2(this.baseUrl, this.token, this.sessionId);
      const current = session.agentState ? (decryptDataKeyBase64(session.agentState, this.dataKey) as AgentStateShape | null) : null;
      const currentState: AgentStateShape = current && typeof current === 'object' ? current : {};
      const nextState = updater(currentState);

      const ciphertext = encryptDataKeyBase64(nextState, this.dataKey);
      const res = await patchSessionAgentState({
        baseUrl: this.baseUrl,
        token: this.token,
        sessionId: this.sessionId,
        ciphertext,
        expectedVersion: session.agentStateVersion,
      });

      if (res.ok) return;
      if (res.error === 'version-mismatch') {
        await sleep(computeVersionMismatchBackoffMs(attempt));
        continue;
      }
      throw new Error(`Failed to patch agentState (${res.error})`);
    }
    throw new Error(`Failed to patch agentState due to repeated version mismatches (attempts=${attempts})`);
  }
}
