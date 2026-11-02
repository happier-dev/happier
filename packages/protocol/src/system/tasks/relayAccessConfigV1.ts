import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { AccessProviderSelectionV1Schema, type AccessProviderSelectionV1 } from '../../plugins/contributions/accessProviders.js';
import { isExactBaseCredentialKey } from '../../common/sensitiveKeys.js';
import { stripBrowserDiagnosticUrlValues } from '../../browser/diagnostics/egress/url.js';
import { SystemTaskJsonValueSchema, type SystemTaskJsonValue } from './spec.js';

/** Home uses the same portable selection as every access-provider consumer. */
export const RelayAccessConfigV1Schema = AccessProviderSelectionV1Schema;
export type RelayAccessConfigV1 = Readonly<AccessProviderSelectionV1>;
/** Observed native/display identity, not configuration admission authority. */
export type RelayAccessProviderIdV1 = string;
export type { AccessProviderRefV1, AccessProviderSelectionV1, AccessCredentialPurposeRefV1 } from '../../plugins/contributions/accessProviders.js';

export const RelayAccessTaskSnapshotV1Schema = lazyZodSchema(() => z.strictObject({
  configured: z.boolean(), providerId: z.nullable(z.string()), selection: z.nullable(RelayAccessConfigV1Schema),
  status: z.strictObject({
    state: z.enum(['disabled', 'enabled', 'needs_auth', 'error', 'unknown']),
    shareUrl: z.nullable(z.string()), details: z.nullable(SystemTaskJsonValueSchema),
  }),
}));
export type RelayAccessTaskSnapshotV1 = z.infer<typeof RelayAccessTaskSnapshotV1Schema>;

function projectConfiguration(value: SystemTaskJsonValue): SystemTaskJsonValue {
  if (typeof value === 'string') return stripBrowserDiagnosticUrlValues(value);
  if (Array.isArray(value)) return value.map(projectConfiguration);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !isExactBaseCredentialKey(key))
    .map(([key, entry]) => [key, projectConfiguration(entry)]));
  return value;
}

/** Projection only: execution keeps exact admitted config, including URL credentials. */
export function projectRelayAccessConfigV1(value: unknown): RelayAccessConfigV1 | null {
  const parsed = RelayAccessConfigV1Schema.safeParse(value);
  if (!parsed.success) return null;
  return { ...parsed.data, config: projectConfiguration(parsed.data.config) };
}
