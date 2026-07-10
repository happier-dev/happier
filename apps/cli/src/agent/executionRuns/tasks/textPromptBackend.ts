import type { BackendTargetRefV1 } from '@happier-dev/protocol';

import type { SessionId } from '@/agent/core/AgentMessage';
import { createExecutionRunRuntime } from '@/agent/runtime/bridges/executionRun/runtime/create';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import { resolveExecutionRunPublicBackendId } from '@/agent/runtime/bridges/executionRun/backendTargets';
import type { Credentials } from '@/persistence';
import { readCredentials } from '@/persistence';
import { bootstrapAccountSettingsContext, type AccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';

export type ExecutionRunTextPromptTargetBackend = Readonly<{
  backendId: string;
  backend: ExecutionRunHostRuntime;
  configureSession?: (sessionId: SessionId) => Promise<void>;
}>; 

function resolveExecutionRunTextPromptAccountSettingsContext(params: Readonly<{
  backendTarget: BackendTargetRefV1;
  credentials?: Credentials | null;
  accountSettingsContext?: AccountSettingsContext | null;
}>): Promise<AccountSettingsContext | null> | AccountSettingsContext | null {
  if (params.accountSettingsContext) {
    return params.accountSettingsContext;
  }

  return (async () => {
    const credentials = params.credentials ?? await readCredentials();
    if (!credentials) return null;
    return await bootstrapAccountSettingsContext({
      credentials,
      backendTarget: params.backendTarget,
    });
  })();
}

export async function createExecutionRunTextPromptBackendForTarget(params: Readonly<{
  cwd: string;
  sessionId: string;
  backendTarget: BackendTargetRefV1;
  modelId?: string;
  permissionMode: string;
  intent: string;
  credentials?: Credentials | null;
  accountSettingsContext?: AccountSettingsContext | null;
}>): Promise<ExecutionRunTextPromptTargetBackend> {
  const accountSettingsContext = await resolveExecutionRunTextPromptAccountSettingsContext({
    backendTarget: params.backendTarget,
    credentials: params.credentials,
    accountSettingsContext: params.accountSettingsContext,
  });

  const backendId = resolveExecutionRunPublicBackendId(params.backendTarget);

  return {
    backendId,
    backend: createExecutionRunRuntime({
      cwd: params.cwd,
      backendId,
      backendTarget: params.backendTarget,
      modelId: params.modelId,
      permissionMode: params.permissionMode,
      accountSettings: accountSettingsContext?.settings ?? null,
      start: {
        intent: params.intent,
        retentionPolicy: 'ephemeral',
      },
    }),
  };
}
