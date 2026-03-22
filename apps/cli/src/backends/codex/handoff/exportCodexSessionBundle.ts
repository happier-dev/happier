import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolvePersistedCodexRuntimeIdentity } from '@happier-dev/agents';
import type { DirectSessionsSource } from '@happier-dev/protocol';
import {
  DirectSessionsSourceSchema,
  readAgentRuntimeDescriptorV1ForProvider,
  readCanonicalAgentRuntimeDescriptorV1ForProvider,
} from '@happier-dev/protocol';

import { collectCodexSessionRolloutFiles } from '../directSessions/collectCodexSessionRolloutFiles';
import { resolveCodexHomesForDirectSessionsSource } from '../directSessions/resolveCodexHomesForDirectSessionsSource';
import type { CodexSessionBundle } from '../../../session/handoff/types';

function resolveCodexHome(env: NodeJS.ProcessEnv): string {
  const raw = typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : '';
  return raw || join(homedir(), '.codex');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

async function resolvePreferredCodexHomes(params: Readonly<{
  metadata: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
  activeServerDir: string;
}>): Promise<string[]> {
  const fallbackCodexHome = resolveCodexHome(params.env);
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
  const homePath = typeof runtimeDescriptor.homePath === 'string' ? runtimeDescriptor.homePath : undefined;

  return runtimeDescriptor.home === 'connectedService'
    ? {
      kind: 'codexHome' as const,
      home: 'connectedService' as const,
      ...(connectedServiceId ? { connectedServiceId } : {}),
      ...(connectedServiceProfileId ? { connectedServiceProfileId } : {}),
      ...(homePath ? { homePath } : {}),
    } satisfies DirectSessionsSource
    : {
      kind: 'codexHome' as const,
      home: 'user' as const,
      ...(homePath ? { homePath } : {}),
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
  const source = resolveCodexSource(params.metadata);
  const candidateHomes = await resolvePreferredCodexHomes(params);
  let rollouts = [] as Awaited<ReturnType<typeof collectCodexSessionRolloutFiles>>;
  for (const codexHome of candidateHomes) {
    rollouts = await collectCodexSessionRolloutFiles({
      codexHome,
      remoteSessionId: params.remoteSessionId,
    });
    if (rollouts.length > 0) break;
  }

  if (rollouts.length === 0) {
    throw new Error(`No Codex rollout files found for ${params.remoteSessionId}`);
  }

  const files = await Promise.all(
    rollouts.map(async (rollout) => ({
      relativePath: rollout.fileRelPath,
      contentBase64: Buffer.from(await readFile(rollout.filePath, 'utf8'), 'utf8').toString('base64'),
    })),
  );

  return {
    providerId: 'codex',
    remoteSessionId: params.remoteSessionId,
    affinity: {
      backendMode: runtimeIdentity?.backendMode ?? null,
      ...(source ? { source } : {}),
      ...(runtimeDescriptor ? { runtimeDescriptor } : {}),
    },
    files,
  };
}
