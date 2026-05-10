import type { Metadata } from '@/api/types';

type MetadataRecord = Record<string, unknown>;

export type SessionRuntimeLocalMetadata = Readonly<Partial<Pick<
  Metadata,
  'claudeSessionId' | 'codexSessionId' | 'opencodeSessionId' | 'externalSessionV1'
>>>;

export function cloneSessionRuntimeLocalMetadata(
  runtimeLocalMetadata: SessionRuntimeLocalMetadata,
): SessionRuntimeLocalMetadata {
  return {
    ...runtimeLocalMetadata,
    ...(runtimeLocalMetadata.externalSessionV1
      ? {
          externalSessionV1: {
            ...runtimeLocalMetadata.externalSessionV1,
            source:
              runtimeLocalMetadata.externalSessionV1.source
              && typeof runtimeLocalMetadata.externalSessionV1.source === 'object'
              && !Array.isArray(runtimeLocalMetadata.externalSessionV1.source)
                ? { ...runtimeLocalMetadata.externalSessionV1.source }
                : runtimeLocalMetadata.externalSessionV1.source,
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
    ...(metadata.externalSessionV1 && typeof metadata.externalSessionV1 === 'object' && !Array.isArray(metadata.externalSessionV1)
      ? { externalSessionV1: metadata.externalSessionV1 as Metadata['externalSessionV1'] }
      : {}),
  };

  return Object.keys(picked).length > 0 ? cloneSessionRuntimeLocalMetadata(picked) : undefined;
}
