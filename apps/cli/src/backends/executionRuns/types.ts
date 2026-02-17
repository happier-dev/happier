import type { AgentBackend } from '@/agent/core/AgentBackend';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';

export type ExecutionRunBackendStartContext = Readonly<{
  intentInput?: unknown;
  retentionPolicy?: string;
  intent?: string;
}>;

export type ExecutionRunBackendIsolation = Readonly<{
  env?: Record<string, string>;
  settingsPath?: string;
}>;

export type ExecutionRunBackendFactoryOptions = Readonly<{
  cwd: string;
  backendId: string;
  modelId?: string;
  permissionMode: string;
  permissionHandler: AcpPermissionHandler;
  start?: ExecutionRunBackendStartContext | null;
  isolation?: ExecutionRunBackendIsolation;
}>;

export type ExecutionRunBackendFactory = (opts: ExecutionRunBackendFactoryOptions) => AgentBackend;
