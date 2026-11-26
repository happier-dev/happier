import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { buildCodexAgentRuntimeDescriptor, resolvePersistedCodexRuntimeIdentity } from '@happier-dev/agents';
import type { DirectSessionsSource } from '@happier-dev/protocol';
import {
  DirectSessionsSourceSchema,
  readAgentRuntimeDescriptorV1ForProvider,
  readCanonicalAgentRuntimeDescriptorV1ForProvider,
} from '@happier-dev/protocol';

import { collectCodexSessionRolloutFiles, type CodexRolloutFile } from '../directSessions/collectCodexSessionRolloutFiles';
import { resolveCodexHomesForDirectSessionsSource } from '../directSessions/resolveCodexHomesForDirectSessionsSource';
import { readCodexRolloutHistoryLineage } from '../localControl/readCodexRolloutHistoryLineage';
import { readCodexSessionMetaFromRollout } from '../localControl/rolloutDiscovery';
import { isMatchingCodexRolloutIdentity, parseCodexRolloutFilename } from '../utils/codexSessionFiles';
import { resolveConfiguredCodexHome } from '../utils/resolveConfiguredCodexHome';
import type { CodexSessionBundle } from '../../../session/handoff/types';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

async function collectHandoffFiles(codexHome: string, rollouts: readonly CodexRolloutFile[]): Promise<CodexSessionBundle['files']> {
  const files = new Map<string, CodexSessionBundle['files'][number]>();
  const visiting = new Set<string>();
  const visit = async (rollout: CodexRolloutFile, prefixBytes?: number): Promise<void> => {
    if (visiting.has(rollout.filePath)) throw new Error(`Cyclic Codex history base: ${rollout.fileRelPath}`);
    const lineage = readCodexRolloutHistoryLineage(await readCodexSessionMetaFromRollout(rollout.filePath));
    if (prefixBytes !== undefined && (lineage.kind === 'legacy' || lineage.kind === 'unverified')) {
      throw new Error(`Codex history base is not paginated: ${rollout.fileRelPath}`);
    }
    const fileSize = (await stat(rollout.filePath)).size;
    const sizeBytes = prefixBytes ?? fileSize;
    if (sizeBytes > fileSize) throw new Error(`Incomplete Codex history base: ${rollout.fileRelPath}`);
    const existing = files.get(rollout.filePath);
    if (existing?.contentFile && existing.contentFile.sizeBytes >= sizeBytes) return;
    visiting.add(rollout.filePath);
    if (lineage.kind === 'invalid-base') throw new Error(`Invalid Codex history base: ${rollout.fileRelPath}`);
    if (lineage.kind === 'inherited') {
      const { baseRolloutId, endByteOffset } = lineage;
      const candidates = (await collectCodexSessionRolloutFiles({ codexHome, remoteSessionId: baseRolloutId })).filter((file) =>
        isMatchingCodexRolloutIdentity(parseCodexRolloutFilename(file.filePath)?.sessionId, baseRolloutId));
      if (candidates.length !== 1) throw new Error(`Missing or ambiguous Codex history base rollout: ${baseRolloutId}`);
      await visit(candidates[0], endByteOffset);
    }
    files.set(rollout.filePath, {
      relativePath: rollout.fileRelPath,
      contentFile: { t: 'happier.handoff.file.v1', filePath: rollout.filePath, offsetBytes: 0, sizeBytes },
    });
    visiting.delete(rollout.filePath);
  };
  for (const rollout of rollouts) await visit(rollout);
  return [...files.values()];
}

function sanitizeDirectCodexSourceForHandoff(source: DirectSessionsSource | undefined): DirectSessionsSource | undefined {
  if (!source || source.kind !== 'codexHome') return source;
  // Absolute home paths are machine-specific and must not be transported via handoff bundles.
  const { homePath: _homePath, ...rest } = source as DirectSessionsSource & { homePath?: string };
  return rest as DirectSessionsSource;
}

async function resolvePreferredCodexHomes(params: Readonly<{
  metadata: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
  activeServerDir: string;
}>): Promise<string[]> {
  const fallbackCodexHome = resolveConfiguredCodexHome(params.env);
  const source = resolveCodexSource(params.metadata);
  if (!source || source.kind !== 'codexHome') {
    return [fallbackCodexHome];
  }

  const resolvedHomes = await resolveCodexHomesForDirectSessionsSource({
    source,
    activeServerDir: params.activeServerDir,
    env: params.env,
  });
  return resolvedHomes.includes(fallbackCodexHome) ? resolvedHomes : [...resolvedHomes, fallbackCodexHome];
}

function resolveCodexSource(metadata: Record<string, unknown>): DirectSessionsSource | undefined {
  const runtimeDescriptor = readCanonicalAgentRuntimeDescriptorV1ForProvider(metadata.agentRuntimeDescriptorV1, 'codex');
  const directSession = asRecord(metadata.directSessionV1);
  const parsedDirectSource = directSession?.providerId === 'codex'
    ? DirectSessionsSourceSchema.safeParse(directSession.source)
    : null;
  if (parsedDirectSource?.success && parsedDirectSource.data.kind === 'codexHome') {
    return parsedDirectSource.data;
  }

  if (!runtimeDescriptor?.home) {
    return undefined;
  }

  const connectedServiceId = typeof runtimeDescriptor.connectedServiceId === 'string' ? runtimeDescriptor.connectedServiceId : undefined;
  const connectedServiceProfileId = typeof runtimeDescriptor.connectedServiceProfileId === 'string' ? runtimeDescriptor.connectedServiceProfileId : undefined;
  const connectedServiceGroupId = typeof runtimeDescriptor.connectedServiceGroupId === 'string' ? runtimeDescriptor.connectedServiceGroupId : undefined;

  return runtimeDescriptor.home === 'connectedService'
    ? {
      kind: 'codexHome' as const,
      home: 'connectedService' as const,
      ...(connectedServiceId ? { connectedServiceId } : {}),
      ...(connectedServiceProfileId ? { connectedServiceProfileId } : {}),
      ...(connectedServiceGroupId ? { connectedServiceGroupId } : {}),
    } satisfies DirectSessionsSource
    : {
      kind: 'codexHome' as const,
      home: 'user' as const,
    } satisfies DirectSessionsSource;
}

export async function exportCodexSessionBundle(params: Readonly<{
  metadata: Record<string, unknown>;
  remoteSessionId: string;
  env: NodeJS.ProcessEnv;
  activeServerDir: string;
}>): Promise<CodexSessionBundle> {
  const runtimeIdentity = resolvePersistedCodexRuntimeIdentity(params.metadata);
  const runtimeDescriptor = readAgentRuntimeDescriptorV1ForProvider(params.metadata.agentRuntimeDescriptorV1, 'codex');
  const sanitizedRuntimeDescriptor = runtimeDescriptor
    ? buildCodexAgentRuntimeDescriptor({
      backendMode: runtimeDescriptor.provider.backendMode,
      vendorSessionId: runtimeDescriptor.provider.vendorSessionId ?? null,
      home: runtimeDescriptor.provider.home ?? null,
      connectedServiceId: runtimeDescriptor.provider.connectedServiceId ?? null,
      connectedServiceProfileId: runtimeDescriptor.provider.connectedServiceProfileId ?? null,
      connectedServiceGroupId: runtimeDescriptor.provider.connectedServiceGroupId ?? null,
      homePath: null,
    })
    : null;
  const source = sanitizeDirectCodexSourceForHandoff(resolveCodexSource(params.metadata));
  const candidateHomes = await resolvePreferredCodexHomes(params);
  let rollouts = [] as Awaited<ReturnType<typeof collectCodexSessionRolloutFiles>>;
  let selectedHome = candidateHomes[0];
  for (const codexHome of candidateHomes) {
    rollouts = await collectCodexSessionRolloutFiles({
      codexHome,
      remoteSessionId: params.remoteSessionId,
    });
    if (rollouts.length > 0) {
      selectedHome = codexHome;
      break;
    }
  }

  if (rollouts.length === 0) {
    throw new Error(`No Codex rollout files found for ${params.remoteSessionId}`);
  }

  const files = await collectHandoffFiles(selectedHome, rollouts);

  return {
    providerId: 'codex',
    remoteSessionId: params.remoteSessionId,
    affinity: {
      backendMode: runtimeIdentity?.backendMode ?? null,
      ...(source ? { source } : {}),
      ...(sanitizedRuntimeDescriptor ? { runtimeDescriptor: sanitizedRuntimeDescriptor } : {}),
    },
    files,
  };
}
