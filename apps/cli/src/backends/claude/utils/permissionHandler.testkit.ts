import { vi } from 'vitest';

import type { Session } from '../session';
import { ClaudePermissionRpcRouter } from './permissionRpcRouter';
import type { PermissionRpcPayload } from './permissionRpc';

type AgentState = {
  requests: Record<string, unknown>;
  completedRequests: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
};

type Metadata = Record<string, unknown>;

type PermissionRpcHandler = (payload: PermissionRpcPayload) => unknown | Promise<unknown>;

export class FakeRpcHandlerManager {
  private readonly handlers = new Map<string, PermissionRpcHandler>();

  registerHandler(name: string, handler: PermissionRpcHandler): void {
    this.handlers.set(name, handler);
  }

  getHandler(name: string): PermissionRpcHandler | undefined {
    return this.handlers.get(name);
  }
}

export class FakePermissionClient {
  sessionId: string;
  rpcHandlerManager: FakeRpcHandlerManager;
  agentState: AgentState;
  metadata: Metadata;

  constructor(sessionId: string, opts?: { metadata?: Metadata }) {
    this.sessionId = sessionId;
    this.rpcHandlerManager = new FakeRpcHandlerManager();
    this.agentState = { requests: {}, completedRequests: {}, capabilities: {} };
    this.metadata = opts?.metadata ?? {};
  }

  updateAgentState(updater: (current: AgentState) => AgentState): AgentState {
    this.agentState = updater(this.agentState);
    return this.agentState;
  }

  updateMetadata(updater: (current: Metadata) => Metadata): Metadata {
    this.metadata = updater(this.metadata);
    return this.metadata;
  }

  getAgentStateSnapshot(): AgentState {
    return this.agentState;
  }
}

export function createPermissionHandlerSessionStub(sessionId = 'test-session-id'): {
  session: Session;
  client: FakePermissionClient;
} {
  const client = new FakePermissionClient(sessionId);
  let router: ClaudePermissionRpcRouter | null = null;

  const session = {
    client,
    api: {
      push() {
        return { sendToAllDevices: vi.fn() };
      },
    },
    setLastPermissionMode: vi.fn(),
    getOrCreatePermissionRpcRouter() {
      if (!router) {
        router = new ClaudePermissionRpcRouter(client.rpcHandlerManager);
      }
      return router;
    },
  } as unknown as Session;

  return { session, client };
}

export function createPermissionHandlerSessionStubWithMetadata(params: {
  sessionId?: string;
  metadata: Metadata;
}): { session: Session; client: FakePermissionClient } {
  const client = new FakePermissionClient(params.sessionId ?? 'test-session-id', { metadata: params.metadata });
  let router: ClaudePermissionRpcRouter | null = null;

  const session = {
    client,
    api: {
      push() {
        return { sendToAllDevices: vi.fn() };
      },
    },
    setLastPermissionMode: vi.fn(),
    getOrCreatePermissionRpcRouter() {
      if (!router) {
        router = new ClaudePermissionRpcRouter(client.rpcHandlerManager);
      }
      return router;
    },
  } as unknown as Session;

  return { session, client };
}
