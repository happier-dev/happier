import type { Metadata } from '@/api/types';
import {
  createSessionStateSyncEngine,
  getSessionStateFieldDescriptor,
  type SessionStateApplyReason,
  type SessionStateFieldWriteValue,
} from '@happier-dev/agents';
import type {
  SessionStateCapabilitiesV1,
  SessionStateFieldId,
} from '@happier-dev/protocol';
import { HOST_SESSION_STATE_METADATA_CAPABILITIES } from './sessionStateMetadataCapabilities';

type HostSessionStateMetadataPortParams<F extends SessionStateFieldId> = Readonly<{
  sessionId: string;
  fieldId: F;
  value: SessionStateFieldWriteValue<F>;
  updateMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
  reason: SessionStateApplyReason;
  metadataReason: string;
  postprocess?: (metadata: Metadata) => Metadata;
}>;

function isForbiddenMetadataUpdateError(error: unknown): boolean {
  const record = error && typeof error === 'object'
    ? error as Record<string, unknown>
    : null;
  const code = typeof record?.code === 'string' ? record.code : '';
  if (code === 'forbidden' || code === 'not_authenticated' || code === 'unauthorized') {
    return true;
  }
  return record?.status === 403 || record?.statusCode === 403;
}

export async function writeSessionStateFieldWithMetadataPort<F extends SessionStateFieldId>(
  params: HostSessionStateMetadataPortParams<F>,
): Promise<boolean> {
  if (getSessionStateFieldDescriptor(params.fieldId).deliveryClass === 'durable_required') {
    return false;
  }

  const engine = createSessionStateSyncEngine({
    capabilities: HOST_SESSION_STATE_METADATA_CAPABILITIES,
    facet: null,
    metadataPort: {
      update: async (_sessionId, updater) => {
        try {
          await Promise.resolve(params.updateMetadata((metadata) => {
            const updated = updater(metadata) as Metadata;
            return params.postprocess ? params.postprocess(updated) : updated;
          }));
          return { ok: true, version: 0 };
        } catch (error) {
          if (isForbiddenMetadataUpdateError(error)) {
            return { ok: false, reason: 'forbidden' };
          }
          const code = typeof (error as { code?: unknown } | null)?.code === 'string'
            ? (error as { code: string }).code
            : 'unknown_error';
          if (code === 'unsupported' || code === 'conflict' || code === 'forbidden' || code === 'unknown_error') {
            return { ok: false, reason: code };
          }
          return { ok: false, reason: 'unknown_error' };
        }
      },
    },
  });

  const result = await engine.writeHappierField({
    sessionId: params.sessionId,
    fieldId: params.fieldId,
    value: params.value,
    reason: params.reason,
    metadataReason: params.metadataReason,
    mirrorToProvider: false,
  });
  return result.ok;
}

export function writeSessionStateFieldWithMetadataPortBestEffort<F extends SessionStateFieldId>(
  params: HostSessionStateMetadataPortParams<F>,
): void {
  void writeSessionStateFieldWithMetadataPort(params).catch(() => undefined);
}
