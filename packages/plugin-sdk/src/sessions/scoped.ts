import type { SubscriptionV1 } from '../context';
import type { PluginExternalSessionsServiceV1 } from './external';
import type { PluginSubagentsServiceV1 } from './subagents';

export type SessionScopedSubscriptionEventV1 = Readonly<{
    kind: string;
    payload?: unknown;
}>;

export interface SessionScopedServicesV1 {
    readonly sessionId?: string;
    send(request: unknown): Promise<unknown>;
    subscribe(request: unknown, onEvent: (event: unknown) => void): SubscriptionV1;
    writeMetadata(request: unknown): Promise<void>;
    writeAgentState(request: unknown): Promise<void>;
    readonly subagents: PluginSubagentsServiceV1;
    readonly external: PluginExternalSessionsServiceV1;
}
