import { z } from 'zod';

import { ProviderHttpsUrlSchema } from '../httpsUrlSchema.js';
import { ProviderAgentTargetKeySchema, ProviderLocalIdSchema } from '../ids.js';

/**
 * The wire protocols Happier bundles a Provider or Agent implementation for.
 * This list answers only "does the host ship a plugin that already speaks this
 * protocol"; it never decides whether a declared protocol is valid.
 *
 * A wire protocol is a rendezvous key between two independent plugins: a
 * Provider plugin declares the protocol its endpoint speaks, and an Agent
 * plugin declares the protocols it accepts. The host never interprets the
 * value - it only matches the two declarations - so the bundled vocabulary must
 * not gate a protocol both sides contribute.
 */
export const BUNDLED_PROVIDER_WIRE_PROTOCOLS_V1 = Object.freeze([
  'anthropic',
  'openai-chat',
  'openai-responses',
  'ollama-native',
] as const);

export const BundledProviderWireProtocolSchema = z.enum(BUNDLED_PROVIDER_WIRE_PROTOCOLS_V1);
export type BundledProviderWireProtocol = z.infer<typeof BundledProviderWireProtocolSchema>;

/**
 * An open wire-protocol identifier: a bundled protocol, or any protocol a
 * currently installed Provider or Agent plugin contributes. Never narrow this
 * to the bundled set to reject a protocol or gate a capability.
 */
export type ProviderWireProtocol = BundledProviderWireProtocol | (string & {});

// Deliberately UNANNOTATED. An explicit `z.ZodType<Output, Input>` annotation
// erases the concrete Zod internals, so downstream `z.array(...)` degrades its
// element to `unknown` — which silently broke `acceptsProtocols` typing across
// the Agent contribution projection. The open-protocol intent is carried by the
// exported `ProviderWireProtocol` type above; the schema stays a real ZodString.
export const ProviderWireProtocolSchema = ProviderLocalIdSchema;

const BUNDLED_PROVIDER_WIRE_PROTOCOL_IDS: ReadonlySet<string> = new Set(
  BUNDLED_PROVIDER_WIRE_PROTOCOLS_V1,
);

/**
 * Answers only whether the host bundles an implementation of this protocol.
 * A `false` result means "no bundled implementation", never "invalid protocol".
 */
export function isBundledProviderWireProtocol(
  protocol: ProviderWireProtocol,
): protocol is BundledProviderWireProtocol {
  return BUNDLED_PROVIDER_WIRE_PROTOCOL_IDS.has(protocol);
}

/**
 * Read a bundled wire-protocol fact by an open protocol id.
 *
 * Bundled fact records are exhaustive over the bundled protocols only. A
 * contributed protocol has no entry, so the lookup reports a typed unavailable
 * instead of borrowing another protocol's fact.
 */
export function readBundledProviderWireProtocolFactV1<T>(
  factsByProtocol: Readonly<Record<BundledProviderWireProtocol, T>>,
  protocol: ProviderWireProtocol,
): T | null {
  return isBundledProviderWireProtocol(protocol) ? factsByProtocol[protocol] : null;
}

/**
 * Bounds on protocol-keyed declarations.
 *
 * These arrays were previously capped at the bundled protocol count, so opening
 * the protocol vocabulary would have moved the ceiling rather than removing it.
 * The cap now exists only to bound persisted, synced, and fingerprinted payloads
 * and matches the credential-transport bound already used for the same
 * protocol-keyed declarations; no bundled Provider or Agent declares more than
 * three protocols.
 */
export const PROVIDER_WIRE_PROTOCOL_LIMITS_V1 = Object.freeze({
  maxProtocolsPerDeclaration: 16,
} as const);

export const CapabilitySupportSchema = z.enum(['supported', 'unsupported', 'unknown']);
export type CapabilitySupport = z.infer<typeof CapabilitySupportSchema>;

export const ProviderCompatibilityCapabilitiesV1Schema = z.object({
  streaming: CapabilitySupportSchema,
  toolRoundTrips: CapabilitySupportSchema,
  statefulResponses: CapabilitySupportSchema,
  reasoningControls: CapabilitySupportSchema,
}).strict();
export type ProviderCompatibilityCapabilitiesV1 = z.infer<typeof ProviderCompatibilityCapabilitiesV1Schema>;

export const PROVIDER_CAPABILITY_KEYS = [
  'streaming',
  'toolRoundTrips',
  'statefulResponses',
  'reasoningControls',
] as const satisfies readonly (keyof ProviderCompatibilityCapabilitiesV1)[];

export const ProviderCompatibilityEvidenceV1Schema = z.object({
  sourceUrls: z.array(ProviderHttpsUrlSchema).min(1).max(16),
  verifiedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  providerVersion: z.string().trim().min(1).max(128).optional(),
  agentVersion: z.string().trim().min(1).max(128).optional(),
  testIds: z.array(z.string().trim().min(1).max(256)).max(64).optional(),
}).strict();
export type ProviderCompatibilityEvidenceV1 = z.infer<typeof ProviderCompatibilityEvidenceV1Schema>;

export const ProviderCompatibilityOverrideV1Schema = z.object({
  agentTargetKey: ProviderAgentTargetKeySchema,
  protocol: ProviderWireProtocolSchema,
  status: z.enum(['verified', 'experimental', 'incompatible']),
  reason: z.string().trim().min(1).max(1024),
  evidence: ProviderCompatibilityEvidenceV1Schema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.status === 'verified' && !value.evidence) {
    ctx.addIssue({ code: 'custom', path: ['evidence'], message: 'Verified compatibility requires evidence' });
  }
});
export type ProviderCompatibilityOverrideV1 = z.infer<typeof ProviderCompatibilityOverrideV1Schema>;

export const ProviderCompatibilityOverridesV1Schema = z.array(ProviderCompatibilityOverrideV1Schema)
  .max(128)
  .superRefine((overrides, ctx) => {
    const keys = new Set<string>();
    overrides.forEach((override, index) => {
      const key = JSON.stringify([override.agentTargetKey, override.protocol]);
      if (keys.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: [index],
          message: 'Compatibility overrides must be unique by agent target and protocol',
        });
      }
      keys.add(key);
    });
  });
