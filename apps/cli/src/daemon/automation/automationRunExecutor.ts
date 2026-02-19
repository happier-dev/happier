import type {
  SpawnSessionErrorCode,
  SpawnSessionOptions,
  SpawnSessionResult,
} from '@/rpc/handlers/registerSessionHandlers';

import { startAutomationLeaseHeartbeat } from './automationLeaseHeartbeat';
import { enqueueAndMaterializeAutomationPrompt } from './automationPendingQueueClient';
import { runAutomationAgainstExistingSession } from './automationRunExistingSession';
import { runAutomationAsNewSession } from './automationRunNewSession';
import { parseAutomationTemplateExecution, type AutomationTemplateEncryption } from './automationTemplateExecution';
import { logAutomationWarn } from './automationTelemetry';
import type { AutomationClaimRunResponse } from './automationTypes';

export type ClaimableRunPayload = Readonly<{
  run: NonNullable<AutomationClaimRunResponse['run']>;
  automation: NonNullable<AutomationClaimRunResponse['automation']>;
}>;

const EXISTING_SESSION_MACHINE_UNAVAILABLE_ERROR_CODES = new Set<SpawnSessionErrorCode>([
  'CHILD_EXITED_BEFORE_WEBHOOK',
  'SESSION_WEBHOOK_TIMEOUT',
  'SPAWN_FAILED',
]);

function normalizeRunFailure(params: {
  targetType: 'new_session' | 'existing_session';
  errorCode: SpawnSessionErrorCode;
  errorMessage: string;
}): { errorCode: string; errorMessage: string } {
  if (
    params.targetType === 'existing_session'
    && EXISTING_SESSION_MACHINE_UNAVAILABLE_ERROR_CODES.has(params.errorCode)
  ) {
    return {
      errorCode: 'existing_session_unavailable_on_machine',
      errorMessage: `Existing-session automation could not run on this machine: ${params.errorMessage}`,
    };
  }

  return {
    errorCode: params.errorCode,
    errorMessage: params.errorMessage,
  };
}

export async function executeClaimedRun(params: {
  token: string;
  machineId: string;
  claimClient: {
    startRun: (params: { runId: string; machineId: string }) => Promise<void>;
    heartbeatRun: (params: {
      runId: string;
      machineId: string;
      leaseDurationMs: number;
    }) => Promise<void>;
    succeedRun: (params: {
      runId: string;
      machineId: string;
      producedSessionId?: string | null;
      summaryCiphertext?: string | null;
    }) => Promise<void>;
    failRun: (params: {
      runId: string;
      machineId: string;
      errorCode: string;
      errorMessage: string;
    }) => Promise<void>;
  };
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  heartbeatMs: number;
  leaseDurationMs: number;
  encryption: AutomationTemplateEncryption;
  claimed: ClaimableRunPayload;
}): Promise<void> {
  const {
    token,
    machineId,
    claimClient,
    spawnSession,
    heartbeatMs,
    leaseDurationMs,
    encryption,
    claimed,
  } = params;

  await claimClient.startRun({ runId: claimed.run.id, machineId });

  const heartbeat = startAutomationLeaseHeartbeat({
    heartbeatMs,
    onHeartbeat: async () => {
      await claimClient.heartbeatRun({
        runId: claimed.run.id,
        machineId,
        leaseDurationMs,
      });
    },
    onError: (error) => {
      logAutomationWarn('Lease heartbeat failed', error, {
        runId: claimed.run.id,
        automationId: claimed.automation.id,
      });
    },
  });

  try {
    const parsedTemplate = parseAutomationTemplateExecution({
      run: {
        id: claimed.run.id,
        automationId: claimed.run.automationId,
      },
      automation: {
        id: claimed.automation.id,
        name: claimed.automation.name,
        enabled: claimed.automation.enabled,
        targetType: claimed.automation.targetType,
        templateCiphertext: claimed.automation.templateCiphertext,
      },
    }, encryption);

    if (!parsedTemplate.ok) {
      await claimClient.failRun({
        runId: claimed.run.id,
        machineId,
        errorCode: 'invalid_template',
        errorMessage: parsedTemplate.error,
      });
      return;
    }

    const template = parsedTemplate.value;

    const spawnResult = template.targetType === 'existing_session'
      ? await runAutomationAgainstExistingSession({
        spawnSession,
        template: {
          directory: template.directory,
          existingSessionId: template.existingSessionId!,
          ...(template.sessionEncryptionKeyBase64 ? { sessionEncryptionKeyBase64: template.sessionEncryptionKeyBase64 } : {}),
          ...(template.sessionEncryptionVariant ? { sessionEncryptionVariant: template.sessionEncryptionVariant } : {}),
          ...(template.agent ? { agent: template.agent } : {}),
          ...(template.profileId !== undefined ? { profileId: template.profileId } : {}),
          ...(template.environmentVariables ? { environmentVariables: template.environmentVariables } : {}),
          ...(template.resume ? { resume: template.resume } : {}),
          ...(template.permissionMode ? { permissionMode: template.permissionMode } : {}),
          ...(typeof template.permissionModeUpdatedAt === 'number' ? { permissionModeUpdatedAt: template.permissionModeUpdatedAt } : {}),
          ...(template.modelId ? { modelId: template.modelId } : {}),
          ...(typeof template.modelUpdatedAt === 'number' ? { modelUpdatedAt: template.modelUpdatedAt } : {}),
          ...(template.terminal ? { terminal: template.terminal } : {}),
          ...(template.windowsRemoteSessionConsole ? { windowsRemoteSessionConsole: template.windowsRemoteSessionConsole } : {}),
          ...(template.experimentalCodexResume !== undefined ? { experimentalCodexResume: template.experimentalCodexResume } : {}),
          ...(template.experimentalCodexAcp !== undefined ? { experimentalCodexAcp: template.experimentalCodexAcp } : {}),
        },
      })
      : await runAutomationAsNewSession({
        spawnSession,
        template: {
          directory: template.directory,
          ...(typeof template.prompt === 'string' && template.prompt.trim().length > 0
            ? { initialPrompt: template.prompt }
            : {}),
          ...(template.agent ? { agent: template.agent } : {}),
          ...(template.profileId !== undefined ? { profileId: template.profileId } : {}),
          ...(template.environmentVariables ? { environmentVariables: template.environmentVariables } : {}),
          ...(template.resume ? { resume: template.resume } : {}),
          ...(template.permissionMode ? { permissionMode: template.permissionMode } : {}),
          ...(typeof template.permissionModeUpdatedAt === 'number' ? { permissionModeUpdatedAt: template.permissionModeUpdatedAt } : {}),
          ...(template.modelId ? { modelId: template.modelId } : {}),
          ...(typeof template.modelUpdatedAt === 'number' ? { modelUpdatedAt: template.modelUpdatedAt } : {}),
          ...(template.terminal ? { terminal: template.terminal } : {}),
          ...(template.windowsRemoteSessionConsole ? { windowsRemoteSessionConsole: template.windowsRemoteSessionConsole } : {}),
          ...(template.experimentalCodexResume !== undefined ? { experimentalCodexResume: template.experimentalCodexResume } : {}),
          ...(template.experimentalCodexAcp !== undefined ? { experimentalCodexAcp: template.experimentalCodexAcp } : {}),
        },
      });

    if (spawnResult.type === 'success') {
      if (template.targetType === 'existing_session' && typeof template.prompt === 'string' && template.prompt.trim().length > 0) {
        const sessionEncryptionKeyBase64 = template.sessionEncryptionKeyBase64?.trim() ?? '';
        if (!sessionEncryptionKeyBase64) {
          await claimClient.failRun({
            runId: claimed.run.id,
            machineId,
            errorCode: 'missing_session_encryption_key',
            errorMessage: 'existing_session automation prompt delivery requires sessionEncryptionKeyBase64',
          });
          return;
        }

        try {
          await enqueueAndMaterializeAutomationPrompt({
            token,
            sessionId: template.existingSessionId!,
            prompt: template.prompt,
            ...(typeof template.displayText === 'string' ? { displayText: template.displayText } : {}),
            sessionEncryptionKeyBase64,
          });
        } catch (error) {
          await claimClient.failRun({
            runId: claimed.run.id,
            machineId,
            errorCode: 'prompt_delivery_failed',
            errorMessage: error instanceof Error ? error.message : String(error),
          });
          return;
        }
      }

      await claimClient.succeedRun({
        runId: claimed.run.id,
        machineId,
        producedSessionId: spawnResult.sessionId,
      });
      return;
    }

    if (spawnResult.type === 'requestToApproveDirectoryCreation') {
      await claimClient.failRun({
        runId: claimed.run.id,
        machineId,
        errorCode: 'directory_approval_required',
        errorMessage: `Directory creation requires approval: ${spawnResult.directory}`,
      });
      return;
    }

    const normalizedFailure = normalizeRunFailure({
      targetType: template.targetType,
      errorCode: spawnResult.errorCode,
      errorMessage: spawnResult.errorMessage,
    });
    await claimClient.failRun({
      runId: claimed.run.id,
      machineId,
      errorCode: normalizedFailure.errorCode,
      errorMessage: normalizedFailure.errorMessage,
    });
  } catch (error) {
    await claimClient.failRun({
      runId: claimed.run.id,
      machineId,
      errorCode: 'unexpected_error',
      errorMessage: error instanceof Error ? error.message : String(error),
    }).catch((innerError) => {
      logAutomationWarn('Failed to record automation run failure', innerError, {
        runId: claimed.run.id,
        automationId: claimed.automation.id,
      });
    });
  } finally {
    heartbeat.stop();
  }
}
