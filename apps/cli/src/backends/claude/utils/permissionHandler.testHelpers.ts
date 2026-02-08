import { vi } from 'vitest';

import type { Session } from '../session';

export type PermissionRpcPayload = {
  id: string;
  approved: boolean;
  reason?: string;
  mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  allowedTools?: string[];
  allowTools?: string[];
  answers?: Record<string, string>;
};

type AgentState = {
  requests: Record<string, unknown>;
  completedRequests: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
};

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

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.rpcHandlerManager = new FakeRpcHandlerManager();
    this.agentState = { requests: {}, completedRequests: {}, capabilities: {} };
  }

  updateAgentState(updater: (current: AgentState) => AgentState): AgentState {
    this.agentState = updater(this.agentState);
    return this.agentState;
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

  const session = {
    client,
    api: {
      push() {
        return { sendToAllDevices: vi.fn() };
      },
    },
    setLastPermissionMode: vi.fn(),
  } as unknown as Session;

  return { session, client };
}
