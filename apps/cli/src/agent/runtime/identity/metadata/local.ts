import type { Metadata } from '@/api/types';
import {
  AgentNativeResumeIdentityV1Schema,
  readRuntimeDescriptorV1FromMetadata,
  type AgentNativeResumeIdentityV1,
  type RuntimeDescriptorV1,
} from '@happier-dev/protocol';

type MetadataRecord = Record<string, unknown>;

export type SessionRuntimeLocalMetadata = Readonly<{
  runtimeDescriptorV1?: RuntimeDescriptorV1;
  nativeResumeIdentityV1?: AgentNativeResumeIdentityV1;
  claudeSessionId?: string;
  codexSessionId?: string;
  opencodeSessionId?: string;
  externalSessionV1?: Metadata['externalSessionV1'];
}>;

export function cloneSessionRuntimeLocalMetadata(
  runtimeLocalMetadata: SessionRuntimeLocalMetadata,
): SessionRuntimeLocalMetadata {
  return {
    ...runtimeLocalMetadata,
    ...(runtimeLocalMetadata.nativeResumeIdentityV1
      ? { nativeResumeIdentityV1: { ...runtimeLocalMetadata.nativeResumeIdentityV1 } }
      : {}),
    ...(runtimeLocalMetadata.runtimeDescriptorV1
      ? {
          runtimeDescriptorV1: {
            ...runtimeLocalMetadata.runtimeDescriptorV1,
            agent: { ...runtimeLocalMetadata.runtimeDescriptorV1.agent },
          },
        }
      : {}),
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

  const runtimeDescriptorV1 = readRuntimeDescriptorV1FromMetadata(metadata);
  const nativeResumeIdentity = AgentNativeResumeIdentityV1Schema.safeParse(
    metadata.nativeResumeIdentityV1,
  );
  const picked: SessionRuntimeLocalMetadata = {
    ...(runtimeDescriptorV1
      ? { runtimeDescriptorV1 }
      : {}),
    ...(nativeResumeIdentity.success
      ? { nativeResumeIdentityV1: nativeResumeIdentity.data }
      : {}),
    // Compatibility readers for Session metadata persisted by stable
    // cli-v0.2.0@526aa0d and cli-v0.2.1@b1d15a8. Current writers use
    // runtimeDescriptorV1; remove these only after supported stored Sessions
    // can no longer contain the released flat Agent identity fields.
    ...(typeof metadata.claudeSessionId === 'string' ? { claudeSessionId: metadata.claudeSessionId } : {}),
    ...(typeof metadata.codexSessionId === 'string' ? { codexSessionId: metadata.codexSessionId } : {}),
    ...(typeof metadata.opencodeSessionId === 'string' ? { opencodeSessionId: metadata.opencodeSessionId } : {}),
    ...(metadata.externalSessionV1 && typeof metadata.externalSessionV1 === 'object' && !Array.isArray(metadata.externalSessionV1)
      ? { externalSessionV1: metadata.externalSessionV1 as Metadata['externalSessionV1'] }
      : {}),
  };

  return Object.keys(picked).length > 0 ? cloneSessionRuntimeLocalMetadata(picked) : undefined;
}
