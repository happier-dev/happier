import type { Metadata } from '@/api/types';
import type { SessionStateCapabilitiesV1 } from '@happier-dev/protocol';
import {
  createSessionStateSyncEngine,
  type MetadataUpdatePort,
  type VendorResumeIdField,
} from '@happier-dev/agents';

const PROVIDER_SESSION_ID_METADATA_CAPABILITIES: SessionStateCapabilitiesV1 = {
  identity: {
    providerSessionId: {
      supported: true,
      happierToProvider: { supported: false },
      providerToHappier: { supported: false },
    },
  },
};

export type SessionRuntimeIdentityMetadataUpdaterParams = {
  getSessionId: () => string | null;
  sessionId?: string | null;
  updateHappySessionMetadata: (updater: (metadata: Metadata) => Metadata, sessionId: string) => Promise<void> | void;
  lastPublished: { value: string | null };
  decorateMetadata?: (metadata: Metadata, providerSessionId: string) => Metadata;
  afterUpdate?: (sessionId: string) => Promise<void> | void;
};

export function createSessionRuntimeIdentityMetadataUpdater(
  metadataKey: VendorResumeIdField,
): (params: SessionRuntimeIdentityMetadataUpdaterParams) => void {
  return function maybeUpdateSessionRuntimeIdentityMetadata(params: SessionRuntimeIdentityMetadataUpdaterParams): void {
    const raw = params.getSessionId();
    const next = typeof raw === 'string' ? raw.trim() : '';
    if (!next) return;

    if (params.lastPublished.value === next) return;
    const previousValue = params.lastPublished.value;
    const happierSessionId = typeof params.sessionId === 'string' && params.sessionId.trim()
      ? params.sessionId.trim()
      : next;
    params.lastPublished.value = next;
    const rollBackPublishedValue = () => {
      if (params.lastPublished.value === next) {
        params.lastPublished.value = previousValue;
      }
    };

    try {
      const metadataPort: MetadataUpdatePort = {
        update: async (_sessionId, updater) => {
          try {
            await Promise.resolve(params.updateHappySessionMetadata(
              (metadata) => {
                const nextMetadata = updater(metadata) as Metadata;
                return params.decorateMetadata?.(nextMetadata, next) ?? nextMetadata;
              },
              happierSessionId,
            ));
          } catch {
            rollBackPublishedValue();
            return { ok: false, reason: 'unknown_error' };
          }
          return { ok: true, version: 0 };
        },
      };
      const result = createSessionStateSyncEngine({
        capabilities: PROVIDER_SESSION_ID_METADATA_CAPABILITIES,
        facet: null,
        metadataPort,
      }).writeHappierField({
        sessionId: happierSessionId,
        fieldId: 'identity.providerSessionId',
        value: {
          metadataKey,
          value: next,
        },
        reason: 'reconciliation',
        metadataReason: 'runtime-provider-session-id',
        mirrorToProvider: false,
      });
      void Promise.resolve(result)
        .then((writeResult) => {
          if (!writeResult.ok) {
            rollBackPublishedValue();
            return;
          }
          return params.afterUpdate?.(next);
        })
        .catch(() => {
          rollBackPublishedValue();
        });
    } catch {
      rollBackPublishedValue();
    }
  };
}
