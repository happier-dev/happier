import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentState } from '@/api/types';
import type { PermissionResponse } from '@/agent/permissions/BasePermissionHandler';

type PermissionCallback = (payload: PermissionResponse) => void | Promise<void>;

export class FakePermissionRpcHandlerManager {
  private permissionHandler: PermissionCallback | null = null;

  registerHandler<TRequest, TResponse>(
    method: string,
    handler: (payload: TRequest) => TResponse | Promise<TResponse>,
  ): void {
    if (method !== 'permission') return;
    this.permissionHandler = handler as unknown as PermissionCallback;
  }

  async dispatchPermission(payload: PermissionResponse): Promise<void> {
    if (!this.permissionHandler) throw new Error('permission handler not registered');
    await this.permissionHandler(payload);
  }
}

export class FakePermissionSession {
  readonly sessionId = 'session-test';
  readonly rpcHandlerManager = new FakePermissionRpcHandlerManager();
  private agentState: AgentState = { requests: {}, completedRequests: {} };

  asApiSessionClient(): ApiSessionClient {
    return this as unknown as ApiSessionClient;
  }

  getAgentStateSnapshot(): AgentState {
    return this.agentState;
  }

  updateAgentState(updater: (state: AgentState) => AgentState): AgentState {
    this.agentState = updater(this.agentState);
    return this.agentState;
  }

  snapshot(): AgentState {
    return this.agentState;
  }
}
