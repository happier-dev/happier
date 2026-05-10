import type { Metadata } from '@/api/types';
import {
  createSessionStateSyncEngine,
  resolveFingerprintPublication,
  rollbackFingerprintPublication,
  type MetadataUpdatePort,
  type SessionStateFieldWriteValue,
} from '@happier-dev/agents';
import type { RuntimeDescriptorV1, SessionStateCapabilitiesV1 } from '@happier-dev/protocol';

const RUNTIME_DESCRIPTOR_METADATA_CAPABILITIES: SessionStateCapabilitiesV1 = {
  identity: {
    runtimeDescriptor: {
      supported: true,
      happierToProvider: { supported: false },
      providerToHappier: { supported: false },
    },
  },
};

export type SessionRuntimeDescriptorPublicationState = Readonly<{
  getSessionId: () => string | null;
  getFingerprint: () => string | null;
  setSessionId: (sessionId: string | null) => void;
  setFingerprint: (fingerprint: string | null) => void;
}>;

export async function publishSessionRuntimeDescriptor(params: Readonly<{
  sessionId: string;
  fingerprint: string;
  publicationState: SessionRuntimeDescriptorPublicationState;
  updateHappySessionMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
  runtimeDescriptor: RuntimeDescriptorV1 | null;
  buildMetadata: (metadata: Metadata) => Metadata;
}>): Promise<void> {
  const previousSessionId = params.publicationState.getSessionId();
  const previousFingerprint = params.publicationState.getFingerprint();
  const fingerprintDecision = resolveFingerprintPublication({
    state: {
      lastPublishedFingerprint: previousFingerprint,
      rollbackFingerprint: null,
    },
    nextFingerprint: params.fingerprint,
  });

  if (
    previousSessionId === params.sessionId
    && !fingerprintDecision.publish
  ) {
    return;
  }

  params.publicationState.setSessionId(params.sessionId);
  params.publicationState.setFingerprint(fingerprintDecision.state.lastPublishedFingerprint);

  const rollbackPublicationState = (): void => {
    const fingerprintState = fingerprintDecision.publish
      ? rollbackFingerprintPublication(fingerprintDecision.state)
      : { lastPublishedFingerprint: previousFingerprint };
    params.publicationState.setSessionId(previousSessionId);
    params.publicationState.setFingerprint(fingerprintState.lastPublishedFingerprint);
  };

  try {
    const metadataPort: MetadataUpdatePort = {
      update: async (_sessionId, updater) => {
        await Promise.resolve(params.updateHappySessionMetadata((metadata) =>
          params.buildMetadata(updater(metadata) as Metadata),
        ));
        return { ok: true, version: 0 };
      },
    };
    const result = await createSessionStateSyncEngine({
      capabilities: RUNTIME_DESCRIPTOR_METADATA_CAPABILITIES,
      facet: null,
      metadataPort,
    }).writeHappierField({
      sessionId: params.sessionId,
      fieldId: 'identity.runtimeDescriptor',
      value: params.runtimeDescriptor as SessionStateFieldWriteValue<'identity.runtimeDescriptor'>,
      reason: 'reconciliation',
      metadataReason: 'runtime-descriptor-publication',
      mirrorToProvider: false,
    });
    if (!result.ok) {
      rollbackPublicationState();
    }
  } catch {
    rollbackPublicationState();
  }
}
