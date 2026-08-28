import {
  SPAWN_SESSION_ERROR_CODES,
  type SpawnSessionOptions,
  type SpawnSessionResult,
} from '@/session/shared/spawnSessionContract';
import { mergeSpawnSessionOptions } from '@/rpc/handlers/spawnSessionOptionsContract';
import { prepareSessionCreationTarget } from '@/session/creation/prepareSessionCreationTarget';
import type { SessionAuthoringCheckoutCreationDraftV1 } from '@happier-dev/protocol';

type AutomationNewSessionTemplate = SpawnSessionOptions & Readonly<{
  checkoutCreationDraft?: SessionAuthoringCheckoutCreationDraftV1;
}>;

export async function runAutomationAsNewSession(params: {
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  runId: string;
  template: AutomationNewSessionTemplate;
}): Promise<SpawnSessionResult> {
  const normalizedRunId = params.runId.trim();
  if (!normalizedRunId) {
    return {
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      errorMessage: 'automation run id is required for a new session',
    };
  }
  const { checkoutCreationDraft, ...rawSpawnTemplate } = params.template;
  let spawnTemplate: SpawnSessionOptions = rawSpawnTemplate;
  if (checkoutCreationDraft !== undefined) {
    const prepared = await prepareSessionCreationTarget({
      request: {
        directory: rawSpawnTemplate.directory,
        checkoutCreationDraft,
      },
    });
    if (!prepared.ok) {
      return {
        type: 'error',
        errorCode: prepared.code === 'invalid_directory'
          ? SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST
          : SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
        errorMessage: `automation checkout preparation failed: ${prepared.code}`,
      };
    }
    spawnTemplate = { ...rawSpawnTemplate, directory: prepared.directory };
  }
  return await params.spawnSession(
    mergeSpawnSessionOptions(
      spawnTemplate,
      {
        approvedNewDirectoryCreation: true,
        spawnNonce: `automation:${normalizedRunId}`,
      },
      { omit: ['pendingFirstInput'] },
    ) as SpawnSessionOptions,
  );
}
