import { DirectSessionsSourceSchema, type DirectSessionsSource } from '@happier-dev/protocol';

import { resolveAgentIdFromSessionMetadata } from '../resolveAgentIdFromSessionMetadata.js';
import type { AgentId } from '../types.js';
import { readSessionMetadataRuntimeDescriptor } from './agentRuntimeDescriptor.js';
import { resolvePersistedCodexRuntimeIdentity } from './codexRuntimeIdentity.js';
import { resolveVendorResumeIdFromSessionMetadata } from './vendorResumePolicy.js';
import type { CodexBackendMode } from '../providerSettings/definitions/codex.js';

type ReadTranscriptSource = (metadata: Readonly<Record<string, unknown>>) => DirectSessionsSource;

const transcriptSources = {
  claude: () => ({ kind: 'claudeConfig' }),
  codex: (metadata) => {
    const descriptor = readSessionMetadataRuntimeDescriptor(metadata, 'codex');
    return {
      kind: 'codexHome',
      home: descriptor?.home ?? 'user',
      ...(descriptor?.homePath ? { homePath: descriptor.homePath } : {}),
      ...(descriptor?.connectedServiceId ? { connectedServiceId: descriptor.connectedServiceId } : {}),
      ...(descriptor?.connectedServiceProfileId ? { connectedServiceProfileId: descriptor.connectedServiceProfileId } : {}),
      ...(descriptor?.connectedServiceGroupId ? { connectedServiceGroupId: descriptor.connectedServiceGroupId } : {}),
    };
  },
  opencode: (metadata) => ({
    kind: 'opencodeServer',
    ...(typeof metadata.path === 'string' && metadata.path.trim() ? { directory: metadata.path } : {}),
  }),
  pi: () => ({ kind: 'piAgentDir' }),
} satisfies Partial<Record<AgentId, ReadTranscriptSource>>;

type TranscriptProvider = keyof typeof transcriptSources;

export type DerivedHostedSessionLink = Readonly<{
  v: 1;
  providerId: TranscriptProvider;
  machineId: string;
  remoteSessionId: string;
  source: DirectSessionsSource;
  codexBackendMode?: CodexBackendMode;
}>;

function hasTranscriptReader(providerId: AgentId): providerId is TranscriptProvider {
  return Object.hasOwn(transcriptSources, providerId);
}

export function deriveLinkFromHostedMetadata(metadata: unknown): DerivedHostedSessionLink | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const record = metadata as Readonly<Record<string, unknown>>;
  const machineId = typeof record.machineId === 'string' ? record.machineId.trim() : '';
  const providerId = resolveAgentIdFromSessionMetadata(record);
  if (!machineId || !providerId || !hasTranscriptReader(providerId)) return null;

  const remoteSessionId = resolveVendorResumeIdFromSessionMetadata(providerId, record);
  const source = DirectSessionsSourceSchema.safeParse(transcriptSources[providerId](record));
  if (!remoteSessionId || !source.success) return null;

  const codexBackendMode = providerId === 'codex' ? resolvePersistedCodexRuntimeIdentity(record)?.backendMode : undefined;
  return {
    v: 1, providerId, machineId, remoteSessionId, source: source.data,
    ...(codexBackendMode ? { codexBackendMode } : {}),
  };
}
