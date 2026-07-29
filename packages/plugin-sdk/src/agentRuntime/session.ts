import type {
  AgentSessionCompactRequest,
  AgentSessionRuntimeEvent,
  AgentSessionSendRequest,
} from '@happier-dev/protocol/runtime';
import type { PermissionIntent } from '@happier-dev/agents';
import type { AgentSessionProviderBinding as ProtocolAgentSessionProviderBinding } from '@happier-dev/protocol';
import type { AgentSessionStartupInstructionsV1 } from '@happier-dev/protocol';

import type { JsonValue } from '../identity.js';
import type { Disposable } from '../lifecycle.js';
import type { PluginDiagnosticData } from '../diagnostics.js';
import type { PluginConnectedAccountRef } from '../services/connectedAccounts.js';
import type { AgentSessionConversationRollbackControl } from './controls.js';

export type AgentSessionConnectedAccountSelection = Readonly<{
  purpose: string;
  account: PluginConnectedAccountRef;
}>;

export type TimestampedAgentValue<T> = Readonly<{
  value: T;
  updatedAtMs: number;
}>;

export type AgentLaunchEnvironment = Readonly<{
  values: Readonly<Record<string, string>>;
  unset: readonly string[];
}>;

export type AgentSessionMcpLaunchConfig = Readonly<{
  command: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
}>;

export type AgentSessionProviderBinding = ProtocolAgentSessionProviderBinding;

export type AgentConfigurationScalar = string | number | boolean | null;
export type AgentPermissionIntent = PermissionIntent;

export type AgentSessionConfigurationSnapshot = Readonly<{
  mode: TimestampedAgentValue<string | null>;
  model: TimestampedAgentValue<string | null>;
  permissionIntent: TimestampedAgentValue<AgentPermissionIntent | null>;
  options: Readonly<Record<string, TimestampedAgentValue<AgentConfigurationScalar>>>;
}>;

type AgentSessionOpenBase = Readonly<{
  sessionId: string;
  cwd: string;
  launchEnvironment?: AgentLaunchEnvironment;
  configuration?: AgentSessionConfigurationSnapshot;
  connectedAccounts?: readonly AgentSessionConnectedAccountSelection[];
  mcpServers?: Readonly<Record<string, AgentSessionMcpLaunchConfig>>;
  providerBinding?: AgentSessionProviderBinding;
}>;

type AgentSessionCreateOrResumeOpenBase = AgentSessionOpenBase & Readonly<{
  startupInstructions?: AgentSessionStartupInstructionsV1;
}>;

export type AgentSessionOpenRequest =
  | (AgentSessionCreateOrResumeOpenBase & Readonly<{ kind: 'create' }>)
  | (AgentSessionCreateOrResumeOpenBase & Readonly<{
      kind: 'resume';
      providerSessionId: string;
    }>)
  | (AgentSessionOpenBase & Readonly<{
      kind: 'fork';
      source: Readonly<{
        sessionId: string;
        providerSessionId: string;
        cwd: string;
        target?: Readonly<{
          turnId: string;
          providerCheckpoint: JsonValue;
        }>;
      }>;
    }>);

export type AgentSessionInput = Readonly<{
  text: string;
  structuredInput?: JsonValue;
}>;

export type { AgentSessionSendRequest } from '@happier-dev/protocol/runtime';

export type AgentSessionSendResult =
  | Readonly<{ status: 'admitted' }>
  | Readonly<{
      status: 'rejected' | 'unavailable' | 'unsupported';
      diagnostic: PluginDiagnosticData;
      retryable: boolean;
    }>;

export type AgentSessionCancelResult =
  | Readonly<{ status: 'requested'; turnId: string }>
  | Readonly<{
      status: 'notRunning' | 'unavailable' | 'unsupported';
      diagnostic?: PluginDiagnosticData;
    }>;

export type AgentSessionConfigurationUpdate = AgentSessionConfigurationSnapshot & Readonly<{
  providerBinding?: AgentSessionProviderBinding;
}>;

export type AgentSessionConfigurationResult =
  | Readonly<{ status: 'applied' | 'deferred'; changed: readonly string[] }>
  | Readonly<{
      status: 'rejected' | 'unavailable' | 'unsupported';
      diagnostic: PluginDiagnosticData;
    }>;

export type { AgentSessionRuntimeEvent } from '@happier-dev/protocol/runtime';
export type { AgentSessionCompactRequest } from '@happier-dev/protocol/runtime';

export type AgentSessionCompactResult =
  | Readonly<{ status: 'admitted' }>
  | Readonly<{
      status: 'rejected' | 'unavailable' | 'unsupported';
      diagnostic: PluginDiagnosticData;
      retryable: boolean;
    }>;

export type AgentSessionDisposeReason =
  | 'session_closed'
  | 'plugin_deactivated'
  | 'host_shutdown'
  | 'runtime_recovery';

export interface AgentSessionRuntime extends Disposable {
  dispose(reason?: AgentSessionDisposeReason): void | Promise<void>;
  readonly conversationRollback?: AgentSessionConversationRollbackControl;
  send(
    request: AgentSessionSendRequest,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<AgentSessionSendResult>;
  cancel?(
    request: Readonly<{
      turnId: string;
      reason: 'user' | 'hostShutdown' | 'sessionDispose' | 'runtimeRecovery';
    }>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<AgentSessionCancelResult>;
  updateConfiguration?(
    request: AgentSessionConfigurationUpdate,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<AgentSessionConfigurationResult>;
  compact?(
    request: AgentSessionCompactRequest,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<AgentSessionCompactResult>;
  watch(listener: (event: AgentSessionRuntimeEvent) => void): Disposable;
}
