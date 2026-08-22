import type { StoredCredentials } from '@/persistence';
import {
  createSessionStateSyncEngine,
  type SessionStateFieldWriteValue,
} from '@happier-dev/agents';
import type { SessionStateCapabilitiesV1, SessionStateFieldId } from '@happier-dev/protocol';
import {
  assertSessionMetadataMutationCurrentness,
  type SessionMetadataMutationCurrentness,
} from '@/session/metadata/updateSessionMetadataWithRetry';

import {
  updateSessionMetadataForTarget,
  type UpdateSessionMetadataForTargetResult,
} from './updateSessionMetadataForTarget';

const CLI_SESSION_STATE_METADATA_CAPABILITIES: SessionStateCapabilitiesV1 = {
  identity: {
    runtimeDescriptor: { supported: true, happierToProvider: { supported: false }, providerToHappier: { supported: false } },
    providerSessionId: { supported: true, happierToProvider: { supported: false }, providerToHappier: { supported: false } },
  },
  intent: {
    model: { supported: true, happierToProvider: { supported: false }, providerToHappier: { supported: false } },
    permissionMode: { supported: true, happierToProvider: { supported: false }, providerToHappier: { supported: false } },
    acpSessionMode: { supported: true, happierToProvider: { supported: false }, providerToHappier: { supported: false } },
    acpConfigOption: { supported: true, happierToProvider: { supported: false }, providerToHappier: { supported: false } },
  },
  display: {
    title: { supported: true, happierToProvider: { supported: false }, providerToHappier: { supported: false } },
  },
};

function isForbiddenMetadataUpdateError(error: unknown): boolean {
  const record = error && typeof error === 'object'
    ? error as Record<string, unknown>
    : null;
  const code = typeof record?.code === 'string' ? record.code : '';
  if (code === 'forbidden' || code === 'not_authenticated' || code === 'unauthorized') {
    return true;
  }
  if (record?.status === 403 || record?.statusCode === 403) {
    return true;
  }
  const response = record?.response && typeof record.response === 'object'
    ? record.response as Record<string, unknown>
    : null;
  return response?.status === 403 || response?.statusCode === 403;
}

function resolveMetadataPortFailureCode(
  error: unknown,
): Extract<UpdateSessionMetadataForTargetResult, Readonly<{ ok: false }>>['code'] {
  if (isForbiddenMetadataUpdateError(error)) {
    return 'forbidden';
  }
  const code = typeof (error as { code?: unknown } | null)?.code === 'string'
    ? (error as { code: string }).code
    : '';
  if (code === 'unsupported' || code === 'conflict' || code === 'forbidden' || code === 'unknown_error') {
    return code;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('version-mismatch') || message.includes('after') && message.includes('attempt')) {
    return 'conflict';
  }
  return 'unknown_error';
}

export async function updateSessionStateFieldForTarget<F extends SessionStateFieldId>(params: Readonly<{
  credentials: StoredCredentials;
  idOrPrefix: string;
  fieldId: F;
  value: SessionStateFieldWriteValue<F>;
  metadataReason: string;
  currentness?: SessionMetadataMutationCurrentness;
  maxAttempts?: number;
}>): Promise<UpdateSessionMetadataForTargetResult> {
  assertSessionMetadataMutationCurrentness(params.currentness);
  let targetResult: UpdateSessionMetadataForTargetResult | null = null;
  let portFailureCode: UpdateSessionMetadataForTargetResult extends infer Result
    ? Result extends Readonly<{ ok: false; code: infer Code }>
      ? Code
      : never
    : never = 'unknown_error';
  const engine = createSessionStateSyncEngine({
    capabilities: CLI_SESSION_STATE_METADATA_CAPABILITIES,
    facet: null,
    metadataPort: {
      update: async (sessionId, updater, opts) => {
        try {
          assertSessionMetadataMutationCurrentness(params.currentness);
          const result = await updateSessionMetadataForTarget({
            credentials: params.credentials,
            idOrPrefix: sessionId,
            updater,
            currentness: params.currentness,
            ...(typeof opts.maxAttempts === 'number' ? { maxAttempts: opts.maxAttempts } : {}),
          });
          targetResult = result;
          if (result.ok) {
            return { ok: true, version: result.version };
          }
          return {
            ok: false,
            reason:
              result.code === 'unsupported'
                || result.code === 'conflict'
                || result.code === 'forbidden'
                ? result.code
                : 'unknown_error',
          };
        } catch (error) {
          assertSessionMetadataMutationCurrentness(params.currentness);
          portFailureCode = resolveMetadataPortFailureCode(error);
          return {
            ok: false,
            reason: portFailureCode === 'session_not_found'
              || portFailureCode === 'session_id_ambiguous'
              || portFailureCode === 'encryption_material_unavailable'
              ? 'unknown_error'
              : portFailureCode,
          };
        }
      },
    },
  });

  const writeResult = await engine.writeHappierField({
    sessionId: params.idOrPrefix,
    fieldId: params.fieldId,
    value: params.value,
    reason: 'user-mutation',
    metadataReason: params.metadataReason,
    ...(typeof params.maxAttempts === 'number' ? { maxAttempts: params.maxAttempts } : {}),
    mirrorToProvider: false,
  });

  assertSessionMetadataMutationCurrentness(params.currentness);
  if (targetResult) return targetResult;
  if (!writeResult.ok) {
    return { ok: false, code: writeResult.reason === 'unsupported' ? 'unsupported' : portFailureCode };
  }
  return {
    ok: true,
    sessionId: params.idOrPrefix,
    metadata: {},
    version: writeResult.version,
  };
}
