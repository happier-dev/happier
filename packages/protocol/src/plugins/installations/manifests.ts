import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

export const PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1 = 'x-happier-plugin-installation-manifest-publisher' as const;

export const PluginInstallationManifestPublisherProofV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  alg: z.literal('ed25519-machine-installation-v1'),
  machineId: z.string().check(z.trim(), z.minLength(1)),
  installationId: z.string().check(z.trim(), z.minLength(1)),
  issuedAt: z.number().check(z.int(), z.nonnegative()),
  nonce: z.string().check(z.trim(), z.minLength(1)),
  method: z.enum(['GET', 'POST']),
  path: z.string().check(z.trim(), z.minLength(1)),
  bodySha256Base64Url: z.string().check(z.trim(), z.minLength(1)),
  signatureBase64Url: z.string().check(z.trim(), z.minLength(1)),
}));
export type PluginInstallationManifestPublisherProofV1 = z.infer<typeof PluginInstallationManifestPublisherProofV1Schema>;

export const PluginInstallationManifestPublisherHeaderV1Schema = lazyZodSchema(() => z.strictObject({
  proof: PluginInstallationManifestPublisherProofV1Schema,
}));
export type PluginInstallationManifestPublisherHeaderV1 = z.infer<typeof PluginInstallationManifestPublisherHeaderV1Schema>;

function normalizeCanonicalJsonValue(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    return value.map((item) => {
      const normalized = normalizeCanonicalJsonValue(item);
      return typeof normalized === 'undefined' ? null : normalized;
    });
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const normalized = normalizeCanonicalJsonValue((value as Record<string, unknown>)[key]);
      if (typeof normalized !== 'undefined') output[key] = normalized;
    }
    return output;
  }
  return undefined;
}

export function stringifyPluginInstallationManifestCanonicalJsonV1(value: unknown): string {
  return JSON.stringify(normalizeCanonicalJsonValue(value) ?? null);
}

export function createPluginInstallationManifestPublisherSigningInputV1(params: Readonly<{
  proof: Omit<PluginInstallationManifestPublisherProofV1, 'signatureBase64Url'>;
}>): Uint8Array {
  return new TextEncoder().encode(`happier.pluginInstallationManifestPublisher.v1\u0000${stringifyPluginInstallationManifestCanonicalJsonV1({
    proof: params.proof,
  })}`);
}
