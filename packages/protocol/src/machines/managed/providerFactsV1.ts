import * as z from '../../zodRuntimePolicy.js';
import { lazyDefinition } from '../../lazyZodSchema.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { PluginContributionIdentityV1Schema } from '../../plugins/contributionIdentity.js';
import { PluginJsonValueV2Schema } from '../../plugins/contributions/jsonSchema.js';
import { formatSharedSavedSecretRefV1 } from '../../account/settings/savedSecretReferenceV1.js';
import { PluginDeclaredExecutableRefSchema } from '../../plugins/contributions/agentAcpTransport.js';
import { PluginLocalizedStringV2Schema } from '../../plugins/contributions/publicTypes.js';
import { DevcontainerNativeObservationV1Schema } from './devcontainerV1.js';
import { ActionInputIssueSchema } from '../../actions/executor/actionInputValidation.js';
import { MachineSetupSourceApplyV1Schema } from '../setup/machineSetupSourcesV1.js';
import { HomeEnrollmentCarrierFailureV1Schema } from '../../ssh/commandFailure.js';
import { ActionFailureCauseV1Schema } from '../../actions/actionExecutionResult.js';
import { providerAmountFieldsV1 } from '../../common/providerAmountV1.js';

const id = () => z.string().check(z.trim(), z.minLength(1));
const instant = () => z.number().check(z.gte(0));
export const SupportedNativeIntentSchema = lazyDefinition(() => z.enum(['start', 'stop', 'suspend', 'resume', 'delete', 'rebuild']));
export type SupportedNativeIntent = z.infer<typeof SupportedNativeIntentSchema>;
/** Native prerequisite facts, shared by discovery and reviewed configuration. */
export const ManagedPrerequisiteV1Schema = lazyDefinition(() => z.strictObject({
  requirement: PluginDeclaredExecutableRefSchema, status: z.enum(['available', 'unavailable', 'unknown']),
  reason: z.optional(id()),
  /** Exact Setup sources for the incumbent plan/review flow; no repair input interpretation. */
  setupSources: z.optional(MachineSetupSourceApplyV1Schema),
  repairAction: z.optional(z.strictObject({ action: asProtocolZod(PluginContributionIdentityV1Schema), input: PluginJsonValueV2Schema })),
}));
/** Observed host resources, not quotas. Omitted facts remain unknown. */
export const ManagedLocalResourceFactsV1Schema = lazyDefinition(() => z.strictObject({
  observedAt: instant(),
  /** Host topology and running guest allocations; neither describes idle CPU. */
  totalCpuCores: z.optional(z.int().check(z.gte(0))),
  allocatedCpuCores: z.optional(z.int().check(z.gte(0))),
  availableCpuCores: z.optional(z.number().check(z.gte(0))),
  availableMemoryBytes: z.optional(z.int().check(z.gte(0))),
  availableDiskBytes: z.optional(z.int().check(z.gte(0))),
}));
export const ProviderPriceV1Schema = lazyDefinition(() => z.strictObject({
  label: z.optional(PluginLocalizedStringV2Schema),
  ...providerAmountFieldsV1(), source: id(), observedAt: instant(),
}));
export const MACHINE_PROVISIONER_SIZE_DIMENSIONS_V1 = ['cpuCores', 'memoryBytes', 'diskBytes'] as const;
export type MachineProvisionerSizeDimensionV1 = typeof MACHINE_PROVISIONER_SIZE_DIMENSIONS_V1[number];
/** Physical dimensions shared by creation disclosure, resize and native observation. */
export const MachineProvisionerSizeV1Schema = lazyDefinition(() => z.strictObject({
  cpuCores: z.optional(z.number().check(z.gt(0))),
  memoryBytes: z.optional(z.int().check(z.gt(0))),
  diskBytes: z.optional(z.int().check(z.gt(0))),
}).check(z.refine(value => MACHINE_PROVISIONER_SIZE_DIMENSIONS_V1.some(dimension => value[dimension] !== undefined))));
export type MachineProvisionerSizeV1 = z.infer<typeof MachineProvisionerSizeV1Schema>;
/** Exact image target supported by the managed guest CLI supplier. */
export const ManagedGuestCliBuildTargetV1Schema = lazyDefinition(() => z.strictObject({
  os: z.enum(['linux', 'darwin']), arch: z.enum(['x64', 'arm64']),
}));
export type ManagedGuestCliBuildTargetV1 = z.infer<typeof ManagedGuestCliBuildTargetV1Schema>;
/** Observed platform of an existing guest that supports Session holder placement. */
export const ManagedGuestPlatformV1Schema = lazyDefinition(() => z.strictObject({
  ...ManagedGuestCliBuildTargetV1Schema.shape,
  home: z.string().check(z.startsWith('/'), z.refine(value => !value.includes('\0'))),
}));
export type ManagedGuestPlatformV1 = z.infer<typeof ManagedGuestPlatformV1Schema>;
/** Labelled native choices are disclosure, not executable selectors or measured headroom. */
export const ProviderNativeOptionFactsV1Schema = lazyDefinition(() => z.strictObject({
  /** Provider-selected image/host facts; absence supplies no installation target. */
  preparationGuest: z.optional(z.strictObject({ target: ManagedGuestCliBuildTargetV1Schema, remoteHomeDir: id() })),
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
  /** A labelled native networking dimension, for example which public addresses a server gets. */
  network: z.optional(z.strictObject({ id: id(), title: PluginLocalizedStringV2Schema })),
  /** A declared native duration fact; executable fields belong to the option's explicit selector assignments. */
  duration: z.optional(z.strictObject({ id: id(), title: PluginLocalizedStringV2Schema, afterMs: instant(),
    /** Optional native idle termination limit; neither duration is an absolute expiry. */
    idleAfterMs: z.optional(z.number().check(z.gt(0))),
  })),
  /** A published monthly rate is not evidence of a native spending cap. */
  monthlyCapStatus: z.optional(z.enum(['none', 'unknown'])),
}));
export const BillingCapabilitiesV1Schema = lazyDefinition(() => z.strictObject({
  location: z.enum(['local', 'cloud', 'unknown']),
  /** Compute charges while parked; retained storage is described separately by storageCharges. */
  stoppedBilling: z.enum(['billed', 'not-billed', 'unknown']),
  storageCharges: z.optional(z.array(ProviderPriceV1Schema)),
}));
/** Native deletion evidence only. afterMs 0 means deletion on Stop; an omitted date never guesses a Stop time. */
export const ProviderDeletionNoticeV1Schema = lazyDefinition(() => z.strictObject({
  kind: z.literal('stopped-storage'), at: z.optional(instant()),
  rule: z.strictObject({ kind: z.literal('after-stop'), afterMs: z.number().check(z.gte(0)) }),
  consequence: z.literal('disk-deleted'),
}));
export type ProviderDeletionNoticeV1 = z.infer<typeof ProviderDeletionNoticeV1Schema>;

/** Observation, including an explicit withdrawal, supersedes the reviewed provider rule. */
export function resolveProviderDeletionNoticeV1(input: Readonly<{
  observation?: Pick<ProviderObservationV1, 'deletionNotices'>;
  retentionCapabilities?: Pick<RetentionCapabilitiesV1, 'deletionNotices'>;
}>): ProviderDeletionNoticeV1 | null {
  const notices = input.observation?.deletionNotices ?? input.retentionCapabilities?.deletionNotices ?? [];
  let nearest: ProviderDeletionNoticeV1 | null = null;
  for (const notice of notices) {
    if (nearest === null || notice.at !== undefined && (nearest.at === undefined || notice.at < nearest.at)) {
      nearest = notice;
    }
  }
  return nearest;
}

/** App-open attention and native Stop-time scheduling consume this same lead-time projection. */
export function resolveProviderDeletionReminderV1(input: Readonly<{
  observation?: Pick<ProviderObservationV1, 'deletionNotices'>;
  retentionCapabilities?: Pick<RetentionCapabilitiesV1, 'deletionNotices'>;
  leadTimeMs: number;
  nowMs: number;
}>): Readonly<{ notice: ProviderDeletionNoticeV1 & { at: number }; remindAt: number; due: boolean }> | null {
  const notice = resolveProviderDeletionNoticeV1(input);
  if (notice?.at === undefined) return null;
  const remindAt = notice.at - input.leadTimeMs;
  return { notice: { ...notice, at: notice.at }, remindAt, due: input.nowMs >= remindAt };
}

export const RetentionCapabilitiesV1Schema = lazyDefinition(() => z.strictObject({
  supportedIntents: z.array(SupportedNativeIntentSchema),
  /** Leaf-qualified native Stop effect only; the host's admin owner decides promptless poweroff availability. */
  guestLocalStop: z.optional(z.enum(['poweroff', 'process-exit'])),
  /** Omission is unknown; expiry and supported power operations do not imply this fact. */
  finiteOnly: z.optional(z.boolean()),
  deletionNotices: z.optional(z.array(ProviderDeletionNoticeV1Schema)),
  nativeExpiry: z.optional(z.union([
    z.strictObject({ kind: z.literal('unused'), afterMs: z.number().check(z.gt(0)) }),
    z.strictObject({ kind: z.literal('deadline'), at: instant() }),
  ])),
}));
/** Lifecycle facts which remain useful to Home without disclosing a native provider payload. */
function providerObservationLifecycleFieldsV1() {
  return {
    observedAt: instant(),
    availability: z.enum(['present', 'absent', 'unavailable']),
    power: z.optional(z.enum(['running', 'stopped', 'suspended', 'unknown'])),
    storage: z.optional(z.enum(['retained', 'lost', 'unknown'])),
  };
}

function hasConsistentProviderObservationLifecycleV1(value: Readonly<{ availability: string; power?: string }>): boolean {
  return value.availability === 'present' || value.power === undefined || value.power === 'unknown';
}

/** Opaque preset rows disclose only lifecycle state; native diagnostics stay sealed with the preset snapshot. */
export const ManagedOpaquePresetObservationV1Schema = lazyDefinition(() => z.strictObject({
  ...providerObservationLifecycleFieldsV1(),
}).check(z.superRefine((value, context) => {
  if (!hasConsistentProviderObservationLifecycleV1(value)) {
    context.addIssue({ code: 'custom', path: ['power'], message: 'Unavailable resources cannot confirm power.' });
  }
})));

export const ProviderObservationV1Schema = lazyDefinition(() => z.strictObject({
  ...providerObservationLifecycleFieldsV1(),
  billing: z.optional(BillingCapabilitiesV1Schema),
  prices: z.optional(z.array(ProviderPriceV1Schema)),
  size: z.optional(MachineProvisionerSizeV1Schema),
  nativeExpiry: z.optional(instant()),
  deletionNotices: z.optional(z.array(ProviderDeletionNoticeV1Schema)),
  reason: z.optional(id()),
  nativeCause: z.optional(MachineProvisionerNativeCauseV1Schema),
  carrierFailure: z.optional(HomeEnrollmentCarrierFailureV1Schema),
}).check(z.superRefine((value, context) => {
  if (!hasConsistentProviderObservationLifecycleV1(value)) {
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
  /** Set only by the creating provider; retained with the bound resource through enrollment/recovery. */
  origin: z.optional(z.literal('created')),
  devcontainerObservation: z.optional(DevcontainerNativeObservationV1Schema),
}));
/** Diagnostic context only; enrollment still owns actual Home reachability. */
export const ManagedGuestHomeNetworkHintV1Schema = lazyDefinition(() => z.literal('authored_network'));
/** Transport selection only; admitted row custody owns identity and credentials. */
export const ManagedBootstrapNativeCarrierV1Schema = lazyDefinition(() => z.strictObject({
  kind: z.literal('native'),
  transport: z.strictObject({ contributionRef: asProtocolZod(PluginContributionIdentityV1Schema), schemaVersion: z.int().check(z.gt(0)) }),
  homeNetworkHint: z.optional(ManagedGuestHomeNetworkHintV1Schema),
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
  hostKeyEvidence: z.optional(ManagedSshHostKeyEvidenceV1Schema),
  /** The provider installed the host identity from this resource's retained credential. */
  hostKeySource: z.optional(z.literal('retained-credential')),
  credentialRef: SharedSavedSecretRefV1Schema,
}));
export const ManagedBootstrapCarrierV1Schema = lazyDefinition(() => z.discriminatedUnion('kind', [ManagedBootstrapNativeCarrierV1Schema, ManagedBootstrapSshCarrierV1Schema]));
export type ManagedBootstrapCarrierV1 = z.infer<typeof ManagedBootstrapCarrierV1Schema>;
export { ManagedRefusalCodeV1Schema } from './managedRefusalCodeV1.js';
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
  z.strictObject({ localCause: z.literal('plugin_action_input_schema_invalid'),
    action: asProtocolZod(PluginContributionIdentityV1Schema),
    issues: z.array(z.pick(ActionInputIssueSchema, { path: true, code: true })),
  }),
  z.strictObject({ localCause: z.literal('ssh_keyscan_failed'), resultClass: z.enum(['empty', 'invalid', 'command_failed', 'spawn_failed']) }),
  z.strictObject({ localCause: z.literal('native_command_failed'), command: z.enum(['start', 'restart', 'stop', 'create', 'run', 'up', 'edit', 'update', 'delete']),
    exitCode: z.nullable(z.int()),
    failureCause: z.optional(ActionFailureCauseV1Schema),
    stderr: z.optional(z.string().check(z.minLength(1), z.maxLength(MACHINE_PROVISIONER_NATIVE_STDERR_MAX_LENGTH_V1))),
    stderrTruncated: z.optional(z.literal(true)),
  }),
  z.strictObject({ localCause: z.enum(['native_options_changed', 'native_ssh_network_unavailable', 'native_route_unavailable', 'native_lease_ended', 'native_macos_vm_limit_reached']) }),
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
  z.strictObject({ kind: z.literal('bound'), resource: ManagedResourceV1Schema,
    /** This acquire accepted a native start; transient until the first exact Running observation. */
    startPending: z.optional(z.literal(true)) }),
  z.strictObject({ kind: z.literal('pending'), nativeOperationRef: ManagedNativeOperationReferenceV1Schema, nativeCause: z.optional(MachineProvisionerNativeCauseV1Schema) }),
  z.strictObject({ kind: z.literal('unknown'), recovery: ManagedRecoveryHintV1Schema, nativeCause: z.optional(MachineProvisionerNativeCauseV1Schema) }),
  // Providers own definite pre-effect refusal codes, as they do for power and Delete.
  z.strictObject({ kind: z.literal('rejected'), code: id(), nativeCause: z.optional(MachineProvisionerNativeCauseV1Schema) }),
]));
export type BillingCapabilitiesV1 = z.infer<typeof BillingCapabilitiesV1Schema>;
export type RetentionCapabilitiesV1 = z.infer<typeof RetentionCapabilitiesV1Schema>;
export type ManagedOpaquePresetObservationV1 = z.infer<typeof ManagedOpaquePresetObservationV1Schema>;
export type ProviderObservationV1 = z.infer<typeof ProviderObservationV1Schema>;

/** Drops provider-private diagnostics before an opaque preset report reaches Home. */
export function projectManagedOpaquePresetObservationV1(
  observation: ProviderObservationV1 | undefined,
): ManagedOpaquePresetObservationV1 | undefined {
  if (!observation) return undefined;
  return {
    observedAt: observation.observedAt,
    availability: observation.availability,
    ...(observation.power === undefined ? {} : { power: observation.power }),
    ...(observation.storage === undefined ? {} : { storage: observation.storage }),
  };
}
export type ManagedResourceV1 = z.infer<typeof ManagedResourceV1Schema>;
export type ManagedNativeOperationReferenceV1 = z.infer<typeof ManagedNativeOperationReferenceV1Schema>;
export type AcquireResultV1 = z.infer<typeof AcquireResultV1Schema>;
export type ManagedPrerequisiteV1 = z.infer<typeof ManagedPrerequisiteV1Schema>;
export type ManagedLocalResourceFactsV1 = z.infer<typeof ManagedLocalResourceFactsV1Schema>;
export type ProviderNativeOptionFactsV1 = z.infer<typeof ProviderNativeOptionFactsV1Schema>;
