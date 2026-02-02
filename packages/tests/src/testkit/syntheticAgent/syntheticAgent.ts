import type { CapturedEvent } from '../socketClient';
import { createSessionScopedSocketCollector, type SocketCollector } from '../socketClient';
import { decryptDataKeyBase64, encryptDataKeyBase64 } from '../rpcCrypto';
import { fetchSessionV2, patchSessionAgentState } from '../sessions';
import { waitFor } from '../timing';

type PermissionRequest = {
  id: string;
  tool: string;
  args: any;
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
  requests?: Record<string, { tool: string; arguments: any; createdAt?: number | null }>;
  completedRequests?: Record<
    string,
    {
      tool: string;
      arguments: any;
      createdAt?: number | null;
      completedAt?: number | null;
      status: 'canceled' | 'denied' | 'approved';
      reason?: string | null;
      mode?: string | null;
      allowedTools?: string[] | null;
      decision?: string | null;
    }
  >;
};

export class SyntheticAgent {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly sessionId: string;
  private readonly dataKey: Uint8Array;
  private readonly socket: SocketCollector;

  constructor(params: { baseUrl: string; token: string; sessionId: string; dataKey: Uint8Array }) {
    this.baseUrl = params.baseUrl;
    this.token = params.token;
    this.sessionId = params.sessionId;
    this.dataKey = params.dataKey;
    this.socket = createSessionScopedSocketCollector(this.baseUrl, this.token, this.sessionId);
  }

  getEvents(): CapturedEvent[] {
    return this.socket.getEvents();
  }

  async start(): Promise<void> {
    this.socket.connect();
    await waitFor(() => this.socket.isConnected(), { timeoutMs: 20_000 });

    const method = `${this.sessionId}:permission`;
    this.socket.onRpcRequest(async (req) => {
      if (req.method !== method) {
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

    await this.socket.rpcRegister(method);
  }

  async stop(): Promise<void> {
    this.socket.close();
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
    const timeoutMs = opts?.timeoutMs ?? 15_000;
    const startedAt = Date.now();
    for (;;) {
      const session = await fetchSessionV2(this.baseUrl, this.token, this.sessionId);
      const state = session.agentState ? (decryptDataKeyBase64(session.agentState, this.dataKey) as AgentStateShape | null) : null;
      const completed = state?.completedRequests ?? {};
      if (completed && completed[permissionId]) return;
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for completed permission: ${permissionId}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
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
      };
      next.completedRequests = completedRequests;
      return next;
    });
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
      if (res.error === 'version-mismatch') continue;
      throw new Error(`Failed to patch agentState (${res.error})`);
    }
    throw new Error('Failed to patch agentState due to repeated version mismatches');
  }
}

