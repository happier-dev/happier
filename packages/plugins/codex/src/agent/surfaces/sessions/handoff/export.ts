import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  expandHomePath,
  resolveHomeDirFromEnvironment,
} from '@happier-dev/plugin-sdk/fs';
import type { HandoffExportSessionMetadata } from '@happier-dev/plugin-sdk/agents/runtime';
import {
  buildCodexAgentRuntimeDescriptor,
  readCanonicalCodexAgentRuntimeDescriptorV1,
} from '../../../../protocol/runtimeDescriptorV1.js';
import { collectCodexRootSessionRolloutFiles } from '../../../rollout/discovery/sessionsForHome.js';
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

/**
 * An explicit linked source is EXCLUSIVE custody, not a ranked preference. The
 * session id alone does not identify bytes: the same id can exist in a second
 * Codex home, so appending the caller environment's `CODEX_HOME` after the
 * authoritative homes lets an unrelated home's same-id rollout be exported as
 * this session's transcript. When the linked source resolves to no home, or to
 * homes without this rollout, that is a typed export failure -- never a
 * substituted source. The environment home is the authority only when the
 * session carries no linked source at all.
 */
async function resolveAuthoritativeCodexHomes(params: Readonly<{
  metadata: HandoffExportSessionMetadata;
  env: NodeJS.ProcessEnv;
  activeServerDir: string;
}>): Promise<string[]> {
  const source = resolveCodexSource(params.metadata);
  if (!source || source.kind !== 'codexHome') {
    return [resolveCodexHome(params.env)];
  }

  return await homes({
    source,
    activeServerDir: params.activeServerDir,
    env: params.env,
  });
}

function resolveCodexSource(metadata: HandoffExportSessionMetadata): CodexExternalSessionSource | undefined {
  const linkedSource = projectAgentExternalSessionSourceToCodex(metadata.externalSessionSource);
  if (linkedSource) return linkedSource;

  const runtimeDescriptor = metadata.runtimeDescriptorV1
    ? readCanonicalCodexAgentRuntimeDescriptorV1(metadata.runtimeDescriptorV1)
    : null;
  if (!runtimeDescriptor?.home) return undefined;
  if (runtimeDescriptor.home === 'connectedService' && !runtimeDescriptor.connectedServiceId) {
    return undefined;
  }
  return {
    kind: 'codexHome',
    home: runtimeDescriptor.home,
    ...(runtimeDescriptor.connectedServiceId
      ? { connectedServiceId: runtimeDescriptor.connectedServiceId }
      : {}),
    ...(runtimeDescriptor.connectedServiceProfileId
      ? { connectedServiceProfileId: runtimeDescriptor.connectedServiceProfileId }
      : {}),
    ...(runtimeDescriptor.connectedServiceGroupId
      ? { connectedServiceGroupId: runtimeDescriptor.connectedServiceGroupId }
      : {}),
  };
}

function resolveCanonicalCodexHandoffBackendMode(
  metadata: HandoffExportSessionMetadata,
): 'acp' | 'appServer' | null {
  const runtimeDescriptor = metadata.runtimeDescriptorV1
    ? readCanonicalCodexAgentRuntimeDescriptorV1(metadata.runtimeDescriptorV1)
    : null;
  return runtimeDescriptor?.backendMode ?? null;
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
  const backendMode = resolveCanonicalCodexHandoffBackendMode(params.metadata);
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
  const candidateHomes = await resolveAuthoritativeCodexHomes(params);
  throwIfAborted(params.signal);
  if (candidateHomes.length === 0) {
    throw new Error(`No Codex home resolved for the linked source of ${params.remoteSessionId}`);
  }
  let rollouts = [] as Awaited<ReturnType<typeof collectCodexRootSessionRolloutFiles>>;
  for (const codexHome of candidateHomes) {
    throwIfAborted(params.signal);
    rollouts = await collectCodexRootSessionRolloutFiles({
      codexHome,
      remoteSessionId: params.remoteSessionId,
    });
    throwIfAborted(params.signal);
    if (rollouts.length > 0) break;
  }

  if (rollouts.length === 0) {
    throw new Error(`No Codex rollout files found for ${params.remoteSessionId} in its authoritative Codex home`);
  }

  const files = await Promise.all(
    rollouts.map(async (rollout) => {
      throwIfAborted(params.signal);
      const sourceStats = await stat(rollout.filePath);
      throwIfAborted(params.signal);
      return {
        relativePath: normalizeCodexHandoffBundleRelativePath(rollout.fileRelPath),
        contentFile: {
          t: 'happier.handoff.file.v1' as const,
          filePath: rollout.filePath,
          offsetBytes: 0,
          sizeBytes: sourceStats.size,
        },
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
