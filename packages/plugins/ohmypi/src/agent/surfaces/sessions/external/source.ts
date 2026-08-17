import {
  resolveSessionFileStoreDirsSync,
} from '@happier-dev/plugin-sdk/sessions/file-stores';
import type { AgentExternalSessionSource } from '@happier-dev/plugin-sdk/sessions/external';

import { OH_MY_PI_SESSION_FILE_STORE_DESCRIPTOR_V1 } from '../../../sessionFileStoreDescriptor.js';

export type OhMyPiExternalSessionSource = Readonly<{
  kind: 'ohMyPiAgentDir';
  agentDir?: string | null;
}>;

export function projectOhMyPiExternalSessionSource(
  source: AgentExternalSessionSource,
): OhMyPiExternalSessionSource | null {
  if (source.kind !== 'ohMyPiAgentDir') return null;
  const agentDir = typeof source.agentDir === 'string' && source.agentDir.trim().length > 0
    ? source.agentDir.trim()
    : null;
  return {
    kind: 'ohMyPiAgentDir',
    ...(agentDir ? { agentDir } : {}),
  };
}

export type OhMyPiSourceValidationResult =
  | Readonly<{ ok: true; source: OhMyPiExternalSessionSource }>
  | Readonly<{ ok: false; error: string }>;

export function canonicalizeOhMyPiExternalSessionsPath(raw: string): string {
  return resolveSessionFileStoreDirsSync({
    product: OH_MY_PI_SESSION_FILE_STORE_DESCRIPTOR_V1,
    grantedRoot: {
      v: 1,
      productId: OH_MY_PI_SESSION_FILE_STORE_DESCRIPTOR_V1.productId,
      agentDir: raw,
      grantedBy: 'host-config',
    },
  }).agentDir;
}

export function resolveConfiguredOhMyPiAgentDir(env: NodeJS.ProcessEnv): string {
  return resolveSessionFileStoreDirsSync({
    product: OH_MY_PI_SESSION_FILE_STORE_DESCRIPTOR_V1,
    env,
  }).agentDir;
}

export function resolveOhMyPiAgentDir(params: Readonly<{
  source: OhMyPiExternalSessionSource;
  env?: NodeJS.ProcessEnv;
}>): string {
  const env = params.env ?? process.env;
  if (params.source.kind !== 'ohMyPiAgentDir') {
    throw new Error('Expected ohMyPiAgentDir source');
  }
  const sourceAgentDir =
    typeof params.source.agentDir === 'string' && params.source.agentDir.trim().length > 0
      ? params.source.agentDir
      : null;
  return sourceAgentDir
    ? canonicalizeOhMyPiExternalSessionsPath(sourceAgentDir)
    : resolveConfiguredOhMyPiAgentDir(env);
}

export function validateOhMyPiExternalSessionSource(params: Readonly<{
  source: OhMyPiExternalSessionSource;
  env?: NodeJS.ProcessEnv;
}>): OhMyPiSourceValidationResult {
  const env = params.env ?? process.env;
  const { source } = params;
  if (source.kind !== 'ohMyPiAgentDir') {
    return { ok: false, error: 'provider/source mismatch' };
  }
  const requestedAgentDir =
    typeof source.agentDir === 'string' && source.agentDir.trim().length > 0
      ? canonicalizeOhMyPiExternalSessionsPath(source.agentDir)
      : null;
  const configuredAgentDir = resolveConfiguredOhMyPiAgentDir(env);
  const agentDir = requestedAgentDir ?? configuredAgentDir;
  return {
    ok: true,
    source: {
      ...source,
      agentDir,
    },
  };
}
