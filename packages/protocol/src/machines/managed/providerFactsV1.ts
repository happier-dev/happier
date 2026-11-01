import * as z from 'zod/mini';
import { lazyDefinition } from '../../lazyZodSchema.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { PluginContributionIdentityV1Schema } from '../../plugins/contributionIdentity.js';
import { PluginJsonValueV2Schema } from '../../plugins/contributions/jsonSchema.js';
import { formatSharedSavedSecretRefV1 } from '../../account/settings/savedSecretReferenceV1.js';
import { PluginDeclaredExecutableRefSchema } from '../../plugins/contributions/agentAcpTransport.js';
import { PluginLocalizedStringV2Schema } from '../../plugins/contributions/publicTypes.js';
import { DevcontainerNativeObservationV1Schema } from './devcontainerV1.js';

const id = () => z.string().check(z.trim(), z.minLength(1));
const instant = () => z.number().check(z.gte(0));
export const SupportedNativeIntentSchema = lazyDefinition(() => z.enum(['start', 'stop', 'suspend', 'resume', 'delete', 'rebuild']));
export type SupportedNativeIntent = z.infer<typeof SupportedNativeIntentSchema>;
/** Native prerequisite facts, shared by discovery and reviewed configuration. */
export const ManagedPrerequisiteV1Schema = lazyDefinition(() => z.strictObject({
  requirement: PluginDeclaredExecutableRefSchema, status: z.enum(['available', 'unavailable', 'unknown']),
  reason: z.optional(id()),
  repairAction: z.optional(z.strictObject({ action: asProtocolZod(PluginContributionIdentityV1Schema), input: PluginJsonValueV2Schema })),
}));
/** Omitted measurements remain unknown; these are observed headroom, not quotas. */
export const ManagedLocalResourceFactsV1Schema = lazyDefinition(() => z.strictObject({
  observedAt: instant(),
  availableCpuCores: z.optional(z.number().check(z.gte(0))),
  availableMemoryBytes: z.optional(z.int().check(z.gte(0))),
  availableDiskBytes: z.optional(z.int().check(z.gte(0))),
}));
export const ProviderPriceV1Schema = lazyDefinition(() => z.strictObject({
  label: z.optional(PluginLocalizedStringV2Schema),
  amount: z.string().check(z.regex(/^-?[0-9]+(?:\.[0-9]+)?$/)),
  currency: id(), unit: id(), source: id(), observedAt: instant(),
}));
/** Labelled native choices are disclosure, not executable selectors or measured headroom. */
export const ProviderNativeOptionFactsV1Schema = lazyDefinition(() => z.strictObject({
  size: z.optional(z.strictObject({
    id: id(), title: PluginLocalizedStringV2Schema,
    cpuCores: z.optional(z.number().check(z.gte(0))),
    memoryBytes: z.optional(z.int().check(z.gte(0))),
    diskBytes: z.optional(z.int().check(z.gte(0))),
  })),
  image: z.optional(z.strictObject({
    id: id(), title: PluginLocalizedStringV2Schema,
    description: z.optional(PluginLocalizedStringV2Schema),
    /** Static packaged image/png Resource; the existing Image owner admits and renders its bytes. */
    preview: z.optional(z.strictObject({
      resource: asProtocolZod(PluginContributionIdentityV1Schema),
      accessibilityLabel: z.optional(PluginLocalizedStringV2Schema),
    })),
  })),
  location: z.optional(z.strictObject({
    id: id(), title: PluginLocalizedStringV2Schema,
    /** Native ISO 3166-1 alpha-2 fact, never inferred from a region id or label. */
    countryCode: z.optional(z.string().check(z.regex(/^[A-Z]{2}$/u))),
  })),
  /** A declared native duration names a complete returned choice; it never names an inferred launch field. */
  duration: z.optional(z.strictObject({ id: id(), title: PluginLocalizedStringV2Schema, afterMs: instant() })),
  /** A published monthly rate is not evidence of a native spending cap. */
  monthlyCapStatus: z.optional(z.enum(['none', 'unknown'])),
}));
export const BillingCapabilitiesV1Schema = lazyDefinition(() => z.strictObject({
  location: z.enum(['local', 'cloud', 'unknown']),
  stoppedBilling: z.enum(['billed', 'not-billed', 'unknown']),
  storageCharges: z.optional(z.array(ProviderPriceV1Schema)),
}));
export const RetentionCapabilitiesV1Schema = lazyDefinition(() => z.strictObject({
  supportedIntents: z.array(SupportedNativeIntentSchema),
  /** Omission is unknown; expiry and supported power operations do not imply this fact. */
  finiteOnly: z.optional(z.boolean()),
  nativeExpiry: z.optional(z.union([
    z.strictObject({ kind: z.literal('unused'), afterMs: z.number().check(z.gt(0)) }),
    z.strictObject({ kind: z.literal('deadline'), at: instant() }),
  ])),
}));
export const ProviderObservationV1Schema = lazyDefinition(() => z.strictObject({
  observedAt: instant(),
  availability: z.enum(['present', 'absent', 'unavailable']),
  power: z.optional(z.enum(['running', 'stopped', 'suspended', 'unknown'])),
  storage: z.optional(z.enum(['retained', 'lost', 'unknown'])),
  daemon: z.optional(z.enum(['connected', 'disconnected', 'unknown'])),
  billing: z.optional(BillingCapabilitiesV1Schema),
  prices: z.optional(z.array(ProviderPriceV1Schema)),
  nativeExpiry: z.optional(instant()),
  reason: z.optional(id()),
  nativeCause: z.optional(MachineProvisionerNativeCauseV1Schema),
}).check(z.superRefine((value, context) => {
  if (value.availability !== 'present' && value.power !== undefined && value.power !== 'unknown') {
    context.addIssue({ code: 'custom', path: ['power'], message: 'Unavailable resources cannot confirm power.' });
  }
})));
export const SharedSavedSecretRefV1Schema = lazyDefinition(() => z.strictObject({
  kind: z.literal('shared_resource'), resourceId: id(),
}).check(z.superRefine((value, context) => {
  try { formatSharedSavedSecretRefV1(value.resourceId); }
  catch { context.addIssue({ code: 'custom', path: ['resourceId'], message: 'Invalid shared SavedSecret reference.' }); }
})));
export const ManagedResourceV1Schema = lazyDefinition(() => z.strictObject({
  contributionRef: asProtocolZod(PluginContributionIdentityV1Schema),
  schemaVersion: z.int().check(z.gt(0)), value: PluginJsonValueV2Schema,
  devcontainerObservation: z.optional(DevcontainerNativeObservationV1Schema),
}));
/** Transport selection only; admitted row custody owns identity and credentials. */
export const ManagedBootstrapNativeCarrierV1Schema = lazyDefinition(() => z.strictObject({
  kind: z.literal('native'),
  transport: z.strictObject({ contributionRef: asProtocolZod(PluginContributionIdentityV1Schema), schemaVersion: z.int().check(z.gt(0)) }),
  guestHome: z.optional(z.strictObject({
    homeDir: z.string().check(z.startsWith('/'), z.refine(value => !value.includes('\0'))),
    happyHomeDir: z.string().check(z.startsWith('/'), z.refine(value => !value.includes('\0'))),
    daemonStartup: z.literal('native-process'),
  })),
}));
export const ManagedSshHostKeyEvidenceV1Schema = lazyDefinition(() => z.strictObject({ hostKey: id(), fingerprint: id() }));
export type ManagedSshHostKeyEvidenceV1 = z.infer<typeof ManagedSshHostKeyEvidenceV1Schema>;
export const ManagedBootstrapSshCarrierV1Schema = lazyDefinition(() => z.strictObject({
  kind: z.literal('ssh'), address: id(), user: id(),
  port: z.optional(z.int().check(z.gte(1), z.lte(65535))),
  hostKeyEvidence: ManagedSshHostKeyEvidenceV1Schema,
  credentialRef: SharedSavedSecretRefV1Schema,
}));
export const ManagedBootstrapCarrierV1Schema = lazyDefinition(() => z.discriminatedUnion('kind', [ManagedBootstrapNativeCarrierV1Schema, ManagedBootstrapSshCarrierV1Schema]));
export type ManagedBootstrapCarrierV1 = z.infer<typeof ManagedBootstrapCarrierV1Schema>;
export const ManagedRefusalCodeV1Schema = lazyDefinition(() => z.enum([
  'invalid_request', 'permission_denied', 'admission_unavailable', 'acquisition_disabled',
  'controller_unavailable', 'controller_retired', 'credential_unavailable', 'provider_unavailable',
  'request_conflict', 'intent_changed', 'managed_not_found', 'enrollment_retired', 'resource_mismatch',
  'preset_not_found', 'preset_archived', 'preset_limit_reached',
]));
export const ManagedNativeOperationReferenceV1Schema = lazyDefinition(() => z.strictObject({ contributionRef: asProtocolZod(PluginContributionIdentityV1Schema), schemaVersion: z.int().check(z.gt(0)), value: PluginJsonValueV2Schema }));
// Native stderr is a diagnostic excerpt bounded to the existing Action-operation
// error-text envelope (10,000 characters), after the canonical privacy projection.
export const MACHINE_PROVISIONER_NATIVE_STDERR_MAX_LENGTH_V1 = 10_000;
/** Native failure facts; process stderr must pass the canonical privacy projection. */
// REST v1 CreateServerRequest field vocabulary (docs.hetzner.cloud/cloud.spec.json,
// inspected 2026-10-26). Closed names prevent reflected input from becoming diagnostics.
const nativeRejectedFields = ['name', 'location', 'server_type', 'start_after_create', 'image', 'placement_group',
  'ssh_keys', 'volumes', 'networks', 'firewalls', 'user_data', 'labels', 'automount', 'public_net'] as const;
export const MachineProvisionerNativeCauseV1Schema = lazyDefinition(() => z.union([
  z.strictObject({ localCause: z.literal('native_command_failed'), command: z.enum(['start', 'restart', 'stop', 'create', 'run', 'up']),
    exitCode: z.nullable(z.int()),
    stderr: z.optional(z.string().check(z.minLength(1), z.maxLength(MACHINE_PROVISIONER_NATIVE_STDERR_MAX_LENGTH_V1))),
    stderrTruncated: z.optional(z.literal(true)),
  }),
  z.strictObject({ localCause: z.enum(['native_options_changed', 'native_ssh_network_unavailable', 'native_route_unavailable', 'native_lease_ended']) }),
  z.strictObject({ localCause: z.literal('native_route_not_found'),
    route: z.enum(['inspect', 'run', 'stop', 'delete', 'pull', 'configure']), httpStatus: z.literal(404) }),
  z.strictObject({ localCause: z.enum(['native_configure_refused', 'native_delete_refused']), httpStatus: z.literal(400) }),
  z.strictObject({ httpStatusClass: z.enum(['3xx', '4xx', '5xx', 'other']), code: z.optional(z.enum([
    'json_error', 'unauthorized', 'forbidden', 'maintenance', 'resource_limit_exceeded', 'not_found',
    'method_not_allowed', 'uniqueness_error', 'conflict', 'deprecated_api_endpoint', 'resource_unavailable',
    'invalid_input', 'service_error', 'unsupported_error', 'locked', 'protected', 'rate_limit_exceeded',
    'server_error', 'bad_gateway', 'unavailable', 'timeout', 'placement_error',
    'bad_request', 'unprocessable_entity', 'too_many_requests',
    'unknown', 'insufficient_capacity', 'volume_placement_capacity', 'name_taken',
  ])), fields: z.optional(z.array(z.enum(nativeRejectedFields)).check(z.maxLength(nativeRejectedFields.length)))
  }).check(z.refine(value => value.fields === undefined || value.code === 'invalid_input' || value.code === 'uniqueness_error')),
  z.strictObject({ grpcStatusCode: z.union([
    z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(7), z.literal(8),
    z.literal(9), z.literal(10), z.literal(11), z.literal(12), z.literal(13), z.literal(14), z.literal(15), z.literal(16),
  ]) }),
  z.strictObject({ sdkError: z.enum(['AlreadyExistsError', 'NotFoundError', 'InvalidError', 'ResourceExhaustedError',
    'TimeoutError', 'SandboxTimeoutError', 'InternalFailure', 'ExecutionError', 'RemoteError', 'ConflictError', 'ClientClosedError']) }),
]));
export type MachineProvisionerNativeCauseV1 = z.infer<typeof MachineProvisionerNativeCauseV1Schema>;
export const ManagedRecoveryHintV1Schema = lazyDefinition(() => z.strictObject({ reference: id(), reason: id(), consoleUrl: z.optional(z.url().check(z.refine((value) => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }))) }));
export const AcquireResultV1Schema = lazyDefinition(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('bound'), resource: ManagedResourceV1Schema }),
  z.strictObject({ kind: z.literal('pending'), nativeOperationRef: ManagedNativeOperationReferenceV1Schema }),
  z.strictObject({ kind: z.literal('unknown'), recovery: ManagedRecoveryHintV1Schema }),
  z.strictObject({ kind: z.literal('rejected'), code: ManagedRefusalCodeV1Schema }),
]));
export type BillingCapabilitiesV1 = z.infer<typeof BillingCapabilitiesV1Schema>;
export type RetentionCapabilitiesV1 = z.infer<typeof RetentionCapabilitiesV1Schema>;
export type ProviderObservationV1 = z.infer<typeof ProviderObservationV1Schema>;
export type ManagedResourceV1 = z.infer<typeof ManagedResourceV1Schema>;
export type ManagedNativeOperationReferenceV1 = z.infer<typeof ManagedNativeOperationReferenceV1Schema>;
export type AcquireResultV1 = z.infer<typeof AcquireResultV1Schema>;
export type ManagedPrerequisiteV1 = z.infer<typeof ManagedPrerequisiteV1Schema>;
export type ManagedLocalResourceFactsV1 = z.infer<typeof ManagedLocalResourceFactsV1Schema>;
export type ProviderNativeOptionFactsV1 = z.infer<typeof ProviderNativeOptionFactsV1Schema>;
