import type { SessionFileStoreProductDescriptorV1 } from './productDescriptor.js';
import { canonicalizePath, resolveConfiguredPath } from './paths.js';

export type SessionFileStoreRootDescriptorV1 = Readonly<{
  v: 1;
  productId: string;
  agentDir: string;
  grantedBy: 'host-config' | 'host-takeover-env' | 'host-external-session-source';
}>;

function readNonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export async function validateSessionFileStoreRootDescriptor(params: Readonly<{
  descriptor: SessionFileStoreRootDescriptorV1;
  product: SessionFileStoreProductDescriptorV1;
  env?: Readonly<Record<string, string | undefined>>;
}>): Promise<Readonly<{ ok: true; canonicalAgentDir: string } | { ok: false; error: string }>> {
  if (params.descriptor.v !== 1) return { ok: false, error: 'unsupported root descriptor version' };
  if (params.descriptor.productId !== params.product.productId) return { ok: false, error: 'product mismatch' };
  const canonicalAgentDir = await canonicalizePath(resolveConfiguredPath(params.descriptor.agentDir));
  if (params.descriptor.grantedBy === 'host-external-session-source') {
    const configuredAgentDir = readNonEmpty(params.env?.[params.product.agentDirEnvVar]);
    if (configuredAgentDir) {
      const canonicalConfigured = await canonicalizePath(resolveConfiguredPath(configuredAgentDir));
      if (canonicalConfigured !== canonicalAgentDir) {
        return { ok: false, error: 'source root does not match configured root' };
      }
    }
  }
  return { ok: true, canonicalAgentDir };
}
