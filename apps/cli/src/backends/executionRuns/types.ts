import type { AgentBackend } from '@/agent/core/AgentBackend';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';

export type ExecutionRunBackendStartContext = Readonly<{ intentInput?: unknown }>;

export type ExecutionRunBackendFactoryOptions = Readonly<{
  cwd: string;
  backendId: string;
  modelId?: string;
  permissionMode: string;
  permissionHandler: AcpPermissionHandler;
  start?: ExecutionRunBackendStartContext | null;
}>;

export type ExecutionRunBackendFactory = (opts: ExecutionRunBackendFactoryOptions) => AgentBackend;

