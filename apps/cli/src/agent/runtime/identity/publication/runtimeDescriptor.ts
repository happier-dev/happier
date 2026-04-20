import type { Metadata } from '@/api/types';

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
  buildMetadata: (metadata: Metadata) => Metadata;
}>): Promise<void> {
  if (
    params.publicationState.getSessionId() === params.sessionId
    && params.publicationState.getFingerprint() === params.fingerprint
  ) {
    return;
  }

  const previousSessionId = params.publicationState.getSessionId();
  const previousFingerprint = params.publicationState.getFingerprint();
  params.publicationState.setSessionId(params.sessionId);
  params.publicationState.setFingerprint(params.fingerprint);

  try {
    await Promise.resolve(
      params.updateHappySessionMetadata((metadata) => params.buildMetadata(metadata)),
    );
  } catch {
    params.publicationState.setSessionId(previousSessionId);
    params.publicationState.setFingerprint(previousFingerprint);
  }
}
