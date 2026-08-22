import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  expandHomePath,
  resolveHomeDirFromEnvironment,
} from '@happier-dev/plugin-sdk/fs';
import type { HandoffExportSessionMetadata } from '@happier-dev/plugin-sdk/agents/runtime';
import { buildCodexAgentRuntimeDescriptor } from '../../../../protocol/runtimeDescriptorV1.js';
import { collectCodexSessionRolloutFiles } from '../../../rollout/discovery/sessionsForHome.js';
import { homes } from '../../../rollout/discovery/sessionsForHomes.js';
import {
  normalizeCodexHandoffBundleRelativePath,
  type CodexSessionHandoffBundle,
} from './bundle.js';
import {
  projectAgentExternalSessionSourceToCodex,
  projectCodexExternalSessionSourceToHandoff,
  type CodexExternalSessionSource,
} from '../external/models.js';

function resolveCodexHome(env: NodeJS.ProcessEnv): string {
  const raw = typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : '';
  const homeDir = resolveHomeDirFromEnvironment(env);
  return raw ? expandHomePath(raw, homeDir) : join(homeDir, '.codex');
}

async function resolvePreferredCodexHomes(params: Readonly<{
  metadata: HandoffExportSessionMetadata;
  env: NodeJS.ProcessEnv;
  activeServerDir: string;
}>): Promise<string[]> {
  const fallbackCodexHome = resolveCodexHome(params.env);
  const source = resolveCodexSource(params.metadata);
  if (!source || source.kind !== 'codexHome') {
    return [fallbackCodexHome];
  }

  const resolvedHomes = await homes({
    source,
    activeServerDir: params.activeServerDir,
    env: params.env,
  });
  return resolvedHomes.includes(fallbackCodexHome) ? resolvedHomes : [...resolvedHomes, fallbackCodexHome];
}

function resolveCodexSource(metadata: HandoffExportSessionMetadata): CodexExternalSessionSource | undefined {
  return projectAgentExternalSessionSourceToCodex(metadata.externalSessionSource) ?? undefined;
}

function resolveCanonicalCodexHandoffBackendMode(
  value: HandoffExportSessionMetadata['codexBackendMode'],
): 'acp' | 'appServer' | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized === 'acp' || normalized === 'appServer' ? normalized : null;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('Codex handoff export was cancelled');
}

export async function exportCodexSessionBundle(params: Readonly<{
  metadata: HandoffExportSessionMetadata;
  remoteSessionId: string;
  env: NodeJS.ProcessEnv;
  activeServerDir: string;
  signal?: AbortSignal;
}>): Promise<CodexSessionHandoffBundle> {
  throwIfAborted(params.signal);
  const backendMode = resolveCanonicalCodexHandoffBackendMode(params.metadata.codexBackendMode);
  const codexSource = resolveCodexSource(params.metadata);
  const source = projectCodexExternalSessionSourceToHandoff(codexSource);
  const sanitizedRuntimeDescriptor = backendMode
    ? buildCodexAgentRuntimeDescriptor({
      backendMode,
      providerSessionId: params.remoteSessionId,
      home: source?.home ?? null,
      connectedServiceId: source?.connectedServiceId ?? null,
      connectedServiceProfileId: source?.connectedServiceProfileId ?? null,
      connectedServiceGroupId: source?.connectedServiceGroupId ?? null,
      homePath: null,
    })
    : null;
  const candidateHomes = await resolvePreferredCodexHomes(params);
  throwIfAborted(params.signal);
  let rollouts = [] as Awaited<ReturnType<typeof collectCodexSessionRolloutFiles>>;
  for (const codexHome of candidateHomes) {
    throwIfAborted(params.signal);
    rollouts = await collectCodexSessionRolloutFiles({
      codexHome,
      remoteSessionId: params.remoteSessionId,
    });
    throwIfAborted(params.signal);
    if (rollouts.length > 0) break;
  }

  if (rollouts.length === 0) {
    throw new Error(`No Codex rollout files found for ${params.remoteSessionId}`);
  }

  const files = await Promise.all(
    rollouts.map(async (rollout) => {
      throwIfAborted(params.signal);
      const content = await readFile(rollout.filePath);
      throwIfAborted(params.signal);
      return {
        relativePath: normalizeCodexHandoffBundleRelativePath(rollout.fileRelPath),
        contentBase64: content.toString('base64'),
      };
    }),
  );
  throwIfAborted(params.signal);

  return {
    agentId: 'codex',
    remoteSessionId: params.remoteSessionId,
    affinity: {
      backendMode,
      ...(source ? { source } : {}),
      ...(sanitizedRuntimeDescriptor ? { runtimeDescriptor: sanitizedRuntimeDescriptor } : {}),
    },
    files,
  };
}
