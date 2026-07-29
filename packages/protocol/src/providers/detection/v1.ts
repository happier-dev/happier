import { z } from 'zod';

import { ProviderCatalogProbeV1Schema } from '../catalog/descriptorV1.js';
import { ProviderEndpointUrlSyntaxSchema } from '../endpointUrlSchema.js';
import { canonicalizeProviderContributionKeyV1 } from '../contributionIdentityV1.js';
import { createProviderFingerprintV1 } from '../fingerprints.js';
import {
  ProviderConnectionIdSchema,
  ProviderContributionKeySchema,
  ProviderLocalIdSchema,
  ProviderMachineIdSchema,
} from '../ids.js';

function isLiteralCommandToken(value: string): boolean {
  return !/[\u0000-\u001f\u007f]/u.test(value)
    && !/[;&|`$<>]/u.test(value)
    && !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(value);
}

const BoundedTokenSchema = z.string().trim().min(1).max(256).refine(
  isLiteralCommandToken,
  'Command token must be literal and control/operator free',
);
const ExecutableLookupNameSchema = z.string().trim().min(1).max(256).refine(
  (value) => value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\')
    && isLiteralCommandToken(value),
  'Executable lookup names must be PATH/application basenames, not paths',
);
const LookupNamesSchema = z.array(ExecutableLookupNameSchema).min(1).max(16);
const EnvironmentVariableNameSchema = z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);

export const ProviderCatalogCommandFallbackV1Schema = z.object({
  endpointTemplateId: ProviderLocalIdSchema,
  lookupNames: LookupNamesSchema,
  fixedArgs: z.array(BoundedTokenSchema).max(32),
  parser: z.literal('ollama-list-table'),
  endpointEnvName: EnvironmentVariableNameSchema.optional(),
}).strict();
export type ProviderCatalogCommandFallbackV1 = z.infer<typeof ProviderCatalogCommandFallbackV1Schema>;

export const ProviderDetectionDescriptorV1Schema = z.object({
  v: z.literal(1),
  listener: z.object({
    executableBasenames: z.array(z.string().trim().min(1).max(128).regex(/^[^/\\\u0000-\u001f]+$/u)).min(1).max(32),
    argvMatch: z.object({
      mode: z.enum(['containsAll', 'orderedSubsequence']),
      tokens: z.array(BoundedTokenSchema).min(1).max(32),
    }).strict().optional(),
    defaultPorts: z.array(z.number().int().min(1).max(65535)).max(16),
  }).strict(),
  availabilityProbe: ProviderCatalogProbeV1Schema,
  installedCheck: z.object({ lookupNames: LookupNamesSchema }).strict().optional(),
  presenceCheck: z.object({
    lookupNames: LookupNamesSchema,
    fixedArgs: z.array(BoundedTokenSchema).max(32),
    parser: z.enum(['exit-zero-running', 'lms-status-json']),
  }).strict().optional(),
  catalogFallback: ProviderCatalogCommandFallbackV1Schema.optional(),
  managedStart: z.object({
    lookupNames: LookupNamesSchema,
    fixedArgs: z.array(BoundedTokenSchema).max(32),
  }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.listener.executableBasenames.map((entry) => entry.toLowerCase())).size !== value.listener.executableBasenames.length) {
    ctx.addIssue({ code: 'custom', path: ['listener', 'executableBasenames'], message: 'Executable basenames must be unique' });
  }
  if (new Set(value.listener.defaultPorts).size !== value.listener.defaultPorts.length) {
    ctx.addIssue({ code: 'custom', path: ['listener', 'defaultPorts'], message: 'Default ports must be unique' });
  }
});
export type ProviderDetectionDescriptorV1 = z.infer<typeof ProviderDetectionDescriptorV1Schema>;

export const ProviderDiscoveryCandidateEvidenceV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('attributed_listener') }).strict(),
  z.object({ kind: z.literal('default_port_hint') }).strict(),
]);
export type ProviderDiscoveryCandidateEvidenceV1 = z.infer<typeof ProviderDiscoveryCandidateEvidenceV1Schema>;

export const ManagedProviderProcessOwnershipSchema = z.enum(['owned', 'adopted']);
export type ManagedProviderProcessOwnership = z.infer<typeof ManagedProviderProcessOwnershipSchema>;

const ProviderDiscoveryCandidateConnectionV1Schema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('matched'), connectionId: ProviderConnectionIdSchema }).strict(),
  z.object({ status: z.literal('enable_default') }).strict(),
  z.object({ status: z.literal('requires_named_connection') }).strict(),
]);

export const ProviderDiscoveryCandidateIdV1Schema = z.string().trim().min(1).max(256)
  .startsWith('discovery-candidate:v1:');
export type ProviderDiscoveryCandidateIdV1 = z.infer<typeof ProviderDiscoveryCandidateIdV1Schema>;

export function createProviderDiscoveryCandidateIdV1(input: Readonly<{
  machineId: string;
  contributionKey: string;
  endpointTemplateId: string;
  normalizedEndpointUrl: string;
}>): ProviderDiscoveryCandidateIdV1 {
  return ProviderDiscoveryCandidateIdV1Schema.parse(createProviderFingerprintV1('discovery-candidate', {
    machineId: ProviderMachineIdSchema.parse(input.machineId),
    contributionKey: canonicalizeProviderContributionKeyV1(
      ProviderContributionKeySchema.parse(input.contributionKey),
    ),
    endpointTemplateId: ProviderLocalIdSchema.parse(input.endpointTemplateId),
    normalizedEndpointUrl: ProviderEndpointUrlSyntaxSchema.parse(input.normalizedEndpointUrl),
  }));
}

/**
 * Redacted pre-connection evidence derived from the daemon's local-listener inventory.
 * A candidate is not endpoint availability and deliberately carries no process facts,
 * model count, credential state, or implicit connection identity.
 */
export const ProviderDiscoveryCandidateV1Schema = z.object({
  v: z.literal(1),
  machineId: ProviderMachineIdSchema,
  contributionKey: ProviderContributionKeySchema,
  providerName: z.string().trim().min(1).max(128),
  endpointTemplateId: ProviderLocalIdSchema,
  normalizedEndpointUrl: ProviderEndpointUrlSyntaxSchema,
  // Optional only for mixed-version reads. Current daemons always issue it;
  // callers must fail closed rather than deriving authority when it is absent.
  candidateId: ProviderDiscoveryCandidateIdV1Schema.optional(),
  evidence: ProviderDiscoveryCandidateEvidenceV1Schema,
  ownership: ManagedProviderProcessOwnershipSchema,
  connection: ProviderDiscoveryCandidateConnectionV1Schema,
}).strict();
export type ProviderDiscoveryCandidateV1 = z.infer<typeof ProviderDiscoveryCandidateV1Schema>;

/** Local binary/application presence when no listening candidate exists. */
export const ProviderLocalInstallationSummaryV1Schema = z.object({
  v: z.literal(1),
  machineId: ProviderMachineIdSchema,
  contributionKey: ProviderContributionKeySchema,
  providerName: z.string().trim().min(1).max(128),
  status: z.enum(['installed_not_running', 'app_running_server_off']),
  managedStartAvailable: z.boolean(),
}).strict();
export type ProviderLocalInstallationSummaryV1 = z.infer<typeof ProviderLocalInstallationSummaryV1Schema>;
