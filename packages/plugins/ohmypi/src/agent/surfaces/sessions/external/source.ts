import {
  resolveSessionFileStoreDirsSync,
} from '@happier-dev/plugin-sdk/experimental/sessions/fileStores';

import type { ExternalSessionsSource } from '@happier-dev/plugin-sdk/experimental/sessions';

import { OH_MY_PI_SESSION_FILE_STORE_DESCRIPTOR_V1 } from '../../../sessionFileStoreDescriptor.js';

export type OhMyPiSourceValidationResult =
  | Readonly<{ ok: true; source: ExternalSessionsSource }>
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
  source: ExternalSessionsSource;
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
  source: ExternalSessionsSource;
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
  if (requestedAgentDir && requestedAgentDir !== configuredAgentDir) {
    return { ok: false, error: 'source agentDir override is not allowed' };
  }
  return {
    ok: true,
    source: {
      ...source,
      agentDir: configuredAgentDir,
    },
  };
}
