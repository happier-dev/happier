import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  readRuntimeDescriptorV1FromMetadata,
  type ExternalSessionsSource,
} from '@happier-dev/plugin-sdk/experimental/sessions';
import { readLinkedExternalSessionV1FromMetadata } from '@happier-dev/protocol';
import { expandHomePath } from '@happier-dev/plugin-sdk/experimental/sessions/fileStores';

import {
  readCanonicalCodexRuntimeDescriptorV1,
  resolvePersistedCodexRuntimeIdentity,
  toCanonicalCodexRuntimeBackendMode,
} from '../../../identity/runtimeDescriptor.js';
import { buildCodexAgentRuntimeDescriptor } from '../../../../protocol/runtimeDescriptorV1.js';
import { collectCodexSessionRolloutFiles } from '../../../rollout/discovery/sessionsForHome.js';
import { homes } from '../../../rollout/discovery/sessionsForHomes.js';
import {
  normalizeCodexHandoffBundleRelativePath,
  type CodexSessionHandoffBundle,
} from './bundle.js';

function resolveCodexHome(env: NodeJS.ProcessEnv): string {
  const raw = typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : '';
  const homeDir = typeof env.HOME === 'string' && env.HOME.trim().length > 0
    ? env.HOME.trim()
    : typeof env.USERPROFILE === 'string' && env.USERPROFILE.trim().length > 0
      ? env.USERPROFILE.trim()
      : homedir();
  return raw ? expandHomePath(raw, homeDir) : join(homeDir, '.codex');
}

function sanitizeExternalCodexSourceForHandoff(source: ExternalSessionsSource | undefined): ExternalSessionsSource | undefined {
  if (!source || source.kind !== 'codexHome') return source;
  // Absolute home paths are machine-specific and must not be transported via handoff bundles.
  const { homePath: _homePath, ...rest } = source as ExternalSessionsSource & { homePath?: string };
  return rest as ExternalSessionsSource;
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

  const resolvedHomes = await homes({
    source,
    activeServerDir: params.activeServerDir,
    env: params.env,
  });
  return resolvedHomes.includes(fallbackCodexHome) ? resolvedHomes : [...resolvedHomes, fallbackCodexHome];
}

function resolveCodexSource(metadata: Record<string, unknown>): ExternalSessionsSource | undefined {
  const runtimeDescriptor = readCanonicalCodexRuntimeDescriptorV1(
    readRuntimeDescriptorV1FromMetadata(metadata),
  );
  const linkedSession = readLinkedExternalSessionV1FromMetadata(metadata);
  if (linkedSession?.agentId === 'codex' && linkedSession.source.kind === 'codexHome') {
    return linkedSession.source;
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
    } satisfies ExternalSessionsSource
    : {
      kind: 'codexHome' as const,
      home: 'user' as const,
    } satisfies ExternalSessionsSource;
}

export async function exportCodexSessionBundle(params: Readonly<{
  metadata: Record<string, unknown>;
  remoteSessionId: string;
  env: NodeJS.ProcessEnv;
  activeServerDir: string;
}>): Promise<CodexSessionHandoffBundle> {
  const runtimeIdentity = resolvePersistedCodexRuntimeIdentity(params.metadata);
  const backendMode = toCanonicalCodexRuntimeBackendMode(runtimeIdentity?.backendMode);
  const runtimeDescriptor = readCanonicalCodexRuntimeDescriptorV1(
    readRuntimeDescriptorV1FromMetadata(params.metadata),
  );
  const sanitizedRuntimeDescriptor = runtimeDescriptor?.backendMode
    ? buildCodexAgentRuntimeDescriptor({
      backendMode: runtimeDescriptor.backendMode,
      providerSessionId: runtimeDescriptor.providerSessionId,
      home: runtimeDescriptor.home,
      connectedServiceId: runtimeDescriptor.connectedServiceId,
      connectedServiceProfileId: runtimeDescriptor.connectedServiceProfileId,
      connectedServiceGroupId: runtimeDescriptor.connectedServiceGroupId,
      homePath: null,
    })
    : null;
  const source = sanitizeExternalCodexSourceForHandoff(resolveCodexSource(params.metadata));
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
      relativePath: normalizeCodexHandoffBundleRelativePath(rollout.fileRelPath),
      contentBase64: (await readFile(rollout.filePath)).toString('base64'),
    })),
  );

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
