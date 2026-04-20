import type { Metadata } from '@/api/types';

type MetadataRecord = Record<string, unknown>;

export type SessionRuntimeLocalMetadata = Readonly<Partial<Pick<
  Metadata,
  'claudeSessionId' | 'codexSessionId' | 'opencodeSessionId' | 'directSessionV1'
>>>;

export function cloneSessionRuntimeLocalMetadata(
  runtimeLocalMetadata: SessionRuntimeLocalMetadata,
): SessionRuntimeLocalMetadata {
  return {
    ...runtimeLocalMetadata,
    ...(runtimeLocalMetadata.directSessionV1
      ? {
          directSessionV1: {
            ...runtimeLocalMetadata.directSessionV1,
            source:
              runtimeLocalMetadata.directSessionV1.source
              && typeof runtimeLocalMetadata.directSessionV1.source === 'object'
              && !Array.isArray(runtimeLocalMetadata.directSessionV1.source)
                ? { ...runtimeLocalMetadata.directSessionV1.source }
                : runtimeLocalMetadata.directSessionV1.source,
          },
        }
      : {}),
  };
}

export function pickSessionRuntimeLocalMetadata(
  metadata: MetadataRecord | null,
): SessionRuntimeLocalMetadata | undefined {
  if (!metadata) {
    return undefined;
  }

  const picked: SessionRuntimeLocalMetadata = {
    ...(typeof metadata.claudeSessionId === 'string' ? { claudeSessionId: metadata.claudeSessionId } : {}),
    ...(typeof metadata.codexSessionId === 'string' ? { codexSessionId: metadata.codexSessionId } : {}),
    ...(typeof metadata.opencodeSessionId === 'string' ? { opencodeSessionId: metadata.opencodeSessionId } : {}),
    ...(metadata.directSessionV1 && typeof metadata.directSessionV1 === 'object' && !Array.isArray(metadata.directSessionV1)
      ? { directSessionV1: metadata.directSessionV1 as Metadata['directSessionV1'] }
      : {}),
  };

  return Object.keys(picked).length > 0 ? cloneSessionRuntimeLocalMetadata(picked) : undefined;
}
