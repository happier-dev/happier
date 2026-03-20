export type BackendIsolationScope = 'execution_run' | 'ephemeral_task';

export type BackendIsolationRequest = Readonly<{
  backendId: string;
  isolationId: string;
  scope: BackendIsolationScope;
  intent?: string;
  cwd: string;
}>;

export type BackendIsolationBundle = Readonly<{
  env: Record<string, string>;
  settingsPath?: string;
  cleanup?: () => void | Promise<void>;
}>;

