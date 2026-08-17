import type { AgentExternalSessionSource } from '@happier-dev/plugin-sdk/sessions/external';
import { canonicalizePathSync } from '@happier-dev/plugin-sdk/fs';
import { resolveSessionFileStoreDirsSync } from '@happier-dev/plugin-sdk/sessions/file-stores';

import { PI_SESSION_FILE_STORE_DESCRIPTOR_V1 } from '../sessionFileStoreDescriptor.js';

export type ResolvedPiExternalSessionSource = Readonly<{
  agentDir: string;
  sessionsRoot: string;
  source: AgentExternalSessionSource;
}>;

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Resolves the source identity every Pi external-session leaf consumes. A
 * canonicalized configured agent directory remains paired with the descriptor's
 * selected session root, which may be a legacy env or settings location rather
 * than `<agentDir>/sessions`.
 */
export function resolvePiExternalSessionSource(params: Readonly<{
  source: AgentExternalSessionSource;
  env: NodeJS.ProcessEnv;
}>): ResolvedPiExternalSessionSource | null {
  if (params.source.kind !== 'piAgentDir') return null;
  const configured = resolveSessionFileStoreDirsSync({
    product: PI_SESSION_FILE_STORE_DESCRIPTOR_V1,
    env: params.env,
  });
  const requestedAgentDir = readOptionalString(params.source.agentDir);
  const agentDir = requestedAgentDir
    ? canonicalizePathSync(requestedAgentDir)
    : configured.agentDir;
  const sessionsRoot = agentDir === configured.agentDir
    ? configured.sessionsRoot
    : resolveSessionFileStoreDirsSync({
      product: PI_SESSION_FILE_STORE_DESCRIPTOR_V1,
      grantedRoot: {
        v: 1,
        productId: PI_SESSION_FILE_STORE_DESCRIPTOR_V1.productId,
        agentDir,
        grantedBy: 'host-config',
      },
    }).sessionsRoot;
  const sessionFile = readOptionalString(params.source.sessionFile);
  const canonicalSessionFile = sessionFile ? canonicalizePathSync(sessionFile) : null;
  return {
    agentDir,
    sessionsRoot,
    source: {
      kind: 'piAgentDir',
      agentDir,
      ...(canonicalSessionFile ? { sessionFile: canonicalSessionFile } : {}),
    },
  };
}
