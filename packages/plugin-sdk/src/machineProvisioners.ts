/** @moduleRealm any */
import type { PluginJsonSchema, ProtocolComposableSchema, ProtocolJsonValue } from './protocol/protocolFacade.js';
import * as canonical from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { prepareMachineProvisionerStoredSchemas as prepareCanonicalStoredSchemas } from '@happier-dev/protocol/plugins/contributions/machineProvisionerStoredSchemas';
import type { ProtocolSchemaSafeParseResult } from './protocol/protocolFacade.js';
import { projectProtocolValue } from './protocol/projectProtocolValue.js';
import type { PluginProcessResult } from './services/io.js';
import type { PluginLocalizedStringV2 } from './manifest.js';
import type { InputPredicate } from './actions/dtos/pluginActionDtoSupport.generated.js';
import type { PluginContributionRef } from './identity.js';
export { MACHINE_PROVISIONER_NATIVE_STDERR_MAX_LENGTH_V1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import type { AcquireResultV1, ManagedBootstrapCarrierV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';

export type MachineProvisionerContributionV1 = Readonly<{
  id: string;
  title: PluginLocalizedStringV2;
  icon: string;
  resourceKind: string;
  /** Human kind and purpose; resourceKind remains native identity, never copy. */
  kindTitle?: PluginLocalizedStringV2;
  description?: PluginLocalizedStringV2;
  launchSchema: PluginJsonSchema;
  resourceSchema: PluginJsonSchema;
  schemaVersion: number;
  platforms: readonly ('darwin' | 'linux' | 'win32')[];
  /** Qualified whole browser API/bootstrap path; absence does not qualify browser acquisition. */
  browserReachable?: boolean;
  prerequisites: readonly Readonly<{ kind: 'managedDependency' | 'systemTool'; id: string | PluginContributionRef }>[];
  billing: Readonly<{ location: 'local' | 'cloud' | 'unknown'; stoppedBilling: 'billed' | 'not-billed' | 'unknown'; storageCharges?: readonly MachineProvisionerPriceV1[] }>;
  retention: Readonly<{ supportedIntents: readonly MachineProvisionerNativeIntentV1[]; guestLocalStop?: 'poweroff' | 'process-exit'; finiteOnly?: boolean; nativeExpiry?: Readonly<{ kind: 'unused'; afterMs: number }> | Readonly<{ kind: 'deadline'; at: number }> }>;
  actions: Readonly<{ check: string; options?: string; acquire: string; bootstrap: string; inspect: string; power?: string; destroy: string; rebuild?: string }>;
  /** Existing options Action field and its raw native input unit; not actual expiry. */
  nativeDurationInput?: Readonly<{ path: string; unit: 'milliseconds' | 'seconds' }>;
  /** Where the provider's own id lives in the resource value (the id its console shows); display only. */
  resourceIdPath?: string;
  bootstrapTransport?: Readonly<{ kind: 'native'; exec: string; putFile: string }>;
  bootstrapCredential?: Readonly<{ kind: 'ssh' | 'native-token' }>;
  nativeCredentialDelivery?: Readonly<{ apply: string; transports: readonly ['https_headers'];
    preservesEndpoint: true; perBindingMatching: true }>;
  /** Qualified native launch variants that do not require a declared purpose. */
  credentialPurposeRequirements?: readonly Readonly<{ purpose: string; optionalWhen: InputPredicate }>[];
  reconciliation?: Readonly<{ nativeOperationSchema: PluginJsonSchema; action: string; cleanup?: string; continueAcquire?: true }>;
}>;
export type MachineProvisionerNativeIntentV1 = 'start' | 'stop' | 'suspend' | 'resume' | 'delete' | 'rebuild';
export type MachineProvisionerPriceV1 = Readonly<{ label?: PluginLocalizedStringV2; amount: string; currency: string; unit: string; source: string; observedAt: number }>;
export type MachineProvisionerAuthorDefinitionV1 = Omit<MachineProvisionerContributionV1, 'id'>;

export type MachineProvisionerNativeCauseV1 = canonical.MachineProvisionerNativeCauseV1;

export type MachineProvisionerCheckResultV1 = Readonly<{ available: boolean; code?: string; status?: PluginLocalizedStringV2; prerequisites?: readonly Readonly<{ requirement: MachineProvisionerContributionV1['prerequisites'][number]; status: 'available' | 'unavailable' | 'unknown'; reason?: string; repairAction?: Readonly<{ action: PluginContributionRef; input: ProtocolJsonValue }> }>[]; localResources?: Readonly<{ observedAt: number; availableCpuCores?: number; availableMemoryBytes?: number; availableDiskBytes?: number }> }>;
export type MachineProvisionerNativeOptionFactsV1 = Readonly<{
  size?: Readonly<{ id: string; title: PluginLocalizedStringV2; cpuCores?: number; memoryBytes?: number; diskBytes?: number }>;
  image?: Readonly<{ id: string; title: PluginLocalizedStringV2 }>;
  location?: Readonly<{ id: string; title: PluginLocalizedStringV2 }>;
  network?: Readonly<{ id: string; title: PluginLocalizedStringV2 }>;
  duration?: Readonly<{ id: string; title: PluginLocalizedStringV2; afterMs: number }>;
  monthlyCapStatus?: 'none' | 'unknown';
}>;
export type DevcontainerEffectReviewV1 = Readonly<{
  kind: 'devcontainer'; reviewedEffectDigest: string;
  effects: readonly Readonly<{ scope: 'host' | 'child';
    kind: 'initialize' | 'image' | 'build' | 'compose' | 'feature' | 'mount' | 'network' | 'environment' | 'user' | 'lifecycle';
    title: string; details: readonly string[];
  }>[];
}>;
/** A named output keeps inferred author Action contracts portable during declaration emission. */
export type MachineProvisionerOptionsResultV1 = Readonly<{
  code?: 'provider_unavailable'; nativeCause?: MachineProvisionerNativeCauseV1;
  base?: Readonly<{ launch: ProtocolJsonValue; available?: boolean; prices?: readonly MachineProvisionerConditionalPriceV1[];
    retention?: MachineProvisionerContributionV1['retention']; nativeFacts?: MachineProvisionerNativeOptionFactsV1; effectReview?: DevcontainerEffectReviewV1 }>;
  dimensions: Readonly<Record<MachineProvisionerDimensionV1, readonly MachineProvisionerDimensionOptionV1[]>>;
  constraints?: readonly MachineProvisionerOptionConstraintV1[];
}>;
export type MachineProvisionerDimensionV1 = 'size' | 'image' | 'location' | 'network' | 'duration';
export type MachineProvisionerSelectionV1 = Readonly<Partial<Record<MachineProvisionerDimensionV1, string>>>;
export type MachineProvisionerOptionSelectorV1 = Readonly<{ dimension: MachineProvisionerDimensionV1; optionIds: readonly string[] }>;
export type MachineProvisionerConditionalPriceV1 = MachineProvisionerPriceV1 & Readonly<{ when?: readonly MachineProvisionerOptionSelectorV1[] }>;
export type MachineProvisionerOptionConstraintV1 = Readonly<{ when: MachineProvisionerOptionSelectorV1; requires: MachineProvisionerOptionSelectorV1 }>;
export type MachineProvisionerDimensionOptionV1 = Readonly<{
  id: string; title: PluginLocalizedStringV2;
  assignments: readonly Readonly<{ path: string; value: ProtocolJsonValue }>[];
  available?: boolean; prices?: readonly MachineProvisionerConditionalPriceV1[];
  retention?: MachineProvisionerContributionV1['retention']; nativeFacts?: MachineProvisionerNativeOptionFactsV1;
}>;
export type MachineProvisionerSelectionProjectionV1 = Readonly<{
  prices: readonly MachineProvisionerPriceV1[]; nativeFacts: MachineProvisionerNativeOptionFactsV1;
  retention?: MachineProvisionerContributionV1['retention']; effectReview?: DevcontainerEffectReviewV1;
}> & (Readonly<{ kind: 'ready'; launch: ProtocolJsonValue }>
  | Readonly<{ kind: 'incomplete' | 'unavailable' | 'invalid'; code: string }>);
export const MACHINE_PROVISIONER_DIMENSIONS_V1: readonly MachineProvisionerDimensionV1[] = /* @__PURE__ */ projectProtocolValue(canonical.MACHINE_PROVISIONER_DIMENSIONS_V1);
export const projectMachineProvisionerSelectionV1: (input: Readonly<{
  options: MachineProvisionerOptionsResultV1; selection: MachineProvisionerSelectionV1; launchSchema: PluginJsonSchema;
}>) => MachineProvisionerSelectionProjectionV1 = /* @__PURE__ */ projectProtocolValue(canonical.projectMachineProvisionerSelectionV1);
export type DevcontainerNativeObservationV1 = Readonly<{
  nativeResourceId: string; user: string; workspaceFolder: string;
  storage: Readonly<{ kind: 'bind'; hostPath: string; childPath: string }> | Readonly<{ kind: 'child'; childPath: string }>;
}>;
export type MachineProvisionerResourceV1<TValue = ProtocolJsonValue> = Readonly<{ contributionRef: PluginContributionRef; schemaVersion: number; value: TValue;
  devcontainerObservation?: DevcontainerNativeObservationV1 }>;
export type MachineProvisionerRefusalCodeV1 = Extract<AcquireResultV1, { kind: 'rejected' }>['code'];
export type MachineProvisionerAcquireResultV1<TResource = ProtocolJsonValue, TNativeOperation = ProtocolJsonValue> = Readonly<{ kind: 'bound'; resource: MachineProvisionerResourceV1<TResource> }> | Readonly<{ kind: 'pending'; nativeOperationRef: MachineProvisionerResourceV1<TNativeOperation> }> | Readonly<{ kind: 'unknown'; recovery: Readonly<{ reference: string; reason: string; consoleUrl?: string }> }> | Readonly<{ kind: 'rejected'; code: MachineProvisionerRefusalCodeV1 }>;
export type MachineProvisionerBootstrapCarrierV1 = ManagedBootstrapCarrierV1;
export type MachineProvisionerObservationV1 = Readonly<{ observedAt: number; availability: 'present' | 'absent' | 'unavailable'; power?: 'running' | 'stopped' | 'suspended' | 'unknown'; storage?: 'retained' | 'lost' | 'unknown'; daemon?: 'connected' | 'disconnected' | 'unknown'; billing?: MachineProvisionerContributionV1['billing']; prices?: readonly MachineProvisionerPriceV1[]; nativeExpiry?: number; reason?: string }>;
export type MachineProvisionerPowerResultV1 = Readonly<{ kind: 'confirmed' }> | Readonly<{ kind: 'unknown'; code?: string }> | Readonly<{ kind: 'refused'; code: string }>;
export type MachineProvisionerNativeCredentialBindingV1 = canonical.MachineProvisionerNativeCredentialBindingV1;
export type MachineProvisionerNativeCredentialApplyInputV1<TResource = ProtocolJsonValue> = canonical.MachineProvisionerNativeCredentialApplyInputV1<TResource>;
export type MachineProvisionerNativeCredentialApplyResultV1 = MachineProvisionerPowerResultV1;
export const MachineProvisionerNativeCredentialApplyInputV1Schema: ProtocolComposableSchema<MachineProvisionerNativeCredentialApplyInputV1> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerNativeCredentialApplyInputProtocolV1Schema);
export const MachineProvisionerNativeCredentialApplyResultV1Schema: ProtocolComposableSchema<MachineProvisionerNativeCredentialApplyResultV1> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerNativeCredentialApplyResultV1Schema);
export type MachineProvisionerDestroyResultV1<TNativeOperation = ProtocolJsonValue> = MachineProvisionerPowerResultV1
  | Readonly<{ kind: 'accepted'; nativeOperationRef: MachineProvisionerResourceV1<TNativeOperation> }>;
export type MachineProvisionerRebuildResultV1<TResource = ProtocolJsonValue> = Extract<MachineProvisionerAcquireResultV1<TResource>, { kind: 'bound' | 'unknown' }> | Readonly<{ kind: 'refused'; code: string }>;
export const MachineProvisionerCheckInputV1Schema: ProtocolComposableSchema<Readonly<Record<string, never>>> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerCheckInputV1Schema);
export const MachineProvisionerCheckResultV1Schema: ProtocolComposableSchema<MachineProvisionerCheckResultV1> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerCheckResultProtocolV1Schema);
export const MachineProvisionerOptionsResultV1Schema: ProtocolComposableSchema<MachineProvisionerOptionsResultV1> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerOptionsResultProtocolV1Schema);
export const MachineProvisionerAcquireResultV1Schema: ProtocolComposableSchema<MachineProvisionerAcquireResultV1> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerAcquireResultV1Schema);
export const MachineProvisionerBootstrapCarrierV1Schema: ProtocolComposableSchema<MachineProvisionerBootstrapCarrierV1> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerBootstrapCarrierV1Schema);
export const MachineProvisionerObservationV1Schema: ProtocolComposableSchema<MachineProvisionerObservationV1> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerObservationV1Schema);
export const MachineProvisionerPowerResultV1Schema: ProtocolComposableSchema<MachineProvisionerPowerResultV1> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerPowerResultV1Schema);
export const MachineProvisionerDestroyResultV1Schema: ProtocolComposableSchema<MachineProvisionerDestroyResultV1> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerDestroyResultV1Schema);
export const MachineProvisionerRebuildResultV1Schema: ProtocolComposableSchema<MachineProvisionerRebuildResultV1> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerRebuildResultV1Schema);
export const MachineProvisionerPutFileResultV1Schema: ProtocolComposableSchema<MachineProvisionerPowerResultV1> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerPutFileResultV1Schema);
export type MachineProvisionerNativeExecResultV1 = (Omit<PluginProcessResult, 'stdout' | 'stderr'> & Readonly<{ stdoutBase64: string; stderrBase64: string }>)
  | Readonly<{ kind: 'process-configured' }>;
export type MachineProvisionerProcessConfigV1 = canonical.MachineProvisionerProcessConfigV1;
export const MachineProvisionerNativeExecResultV1Schema: ProtocolComposableSchema<MachineProvisionerNativeExecResultV1> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerNativeExecResultV1Schema);
export const defineMachineProvisionerSchemas: <LI, LO, RI, RO, C extends true | undefined = undefined>(schemas: Readonly<{ launch: ProtocolComposableSchema<LI, LO>; resource: ProtocolComposableSchema<RI, RO>; continueAcquire?: C }>) => Readonly<{
  checkInput: typeof MachineProvisionerCheckInputV1Schema;
  acquireInput: ProtocolComposableSchema<Readonly<{ launch: LI; managedId?: string; bootstrapPublicKey?: string }> & (C extends true ? Readonly<{ resource?: RI }> : {}),
    Readonly<{ launch: LO; managedId?: string; bootstrapPublicKey?: string }> & (C extends true ? Readonly<{ resource?: RO }> : {})>;
  acquireResult: ProtocolComposableSchema<Exclude<MachineProvisionerAcquireResultV1<RI>, { kind: 'pending' }>, Exclude<MachineProvisionerAcquireResultV1<RO>, { kind: 'pending' }>>;
  rebuildInput: ProtocolComposableSchema<Readonly<{ resource: RI; reviewedEffectDigest: string }>, Readonly<{ resource: RO; reviewedEffectDigest: string }>>;
  rebuildResult: ProtocolComposableSchema<MachineProvisionerRebuildResultV1<RI>, MachineProvisionerRebuildResultV1<RO>>;
  bootstrapInput: ProtocolComposableSchema<Readonly<{ resource: RI; credentialRef?: Readonly<{ kind: 'shared_resource'; resourceId: string }>; bootstrapPublicKey?: string }>, Readonly<{ resource: RO; credentialRef?: Readonly<{ kind: 'shared_resource'; resourceId: string }>; bootstrapPublicKey?: string }>>;
  resourceInput: ProtocolComposableSchema<Readonly<{ resource: RI }>, Readonly<{ resource: RO }>>;
  powerInput: ProtocolComposableSchema<Readonly<{ resource: RI; intent: MachineProvisionerNativeIntentV1 }>, Readonly<{ resource: RO; intent: MachineProvisionerNativeIntentV1 }>>;
  execInput: ProtocolComposableSchema<Readonly<{ resource: RI; argv: readonly string[]; inputBase64?: string; timeoutMs?: number | null; processConfig?: MachineProvisionerProcessConfigV1 }>, Readonly<{ resource: RO; argv: readonly string[]; inputBase64?: string; timeoutMs?: number | null; processConfig?: MachineProvisionerProcessConfigV1 }>>;
  /** One bounded fragment at a host-selected private path. Host assembly owns
   * atomic publication of the complete archive; confirmed means all bytes of
   * this fragment were written, including native process settlement. */
  putFileInput: ProtocolComposableSchema<Readonly<{ resource: RI; guestPath: string; bytesBase64: string; mode?: number }>, Readonly<{ resource: RO; guestPath: string; bytesBase64: string; mode?: number }>>;
}> = /* @__PURE__ */ projectProtocolValue(canonical.defineMachineProvisionerSchemas);

/** Use this result on both acquire and the declared read-only reconciliation Action. */
export const defineMachineProvisionerReconciliationSchemas: <LI, LO, RI, RO, NI, NO>(schemas: Readonly<{
  launch: ProtocolComposableSchema<LI, LO>; resource: ProtocolComposableSchema<RI, RO>; nativeOperation: ProtocolComposableSchema<NI, NO>;
}>) => Readonly<{
  input: ProtocolComposableSchema<
    Readonly<{ nativeOperation: NI }> | Readonly<{ correlation: Readonly<{ managedId: string; requestId: string; launch: LI }> }>,
    Readonly<{ nativeOperation: NO }> | Readonly<{ correlation: Readonly<{ managedId: string; requestId: string; launch: LO }> }>>;
  destroyInput: ProtocolComposableSchema<Readonly<{ resource: RI }> | Readonly<{ nativeOperation: NI }>,
    Readonly<{ resource: RO }> | Readonly<{ nativeOperation: NO }>>;
  destroyResult: ProtocolComposableSchema<MachineProvisionerDestroyResultV1<NI>, MachineProvisionerDestroyResultV1<NO>>;
  cleanupInput: ProtocolComposableSchema<Readonly<{ nativeOperation: NI }>, Readonly<{ nativeOperation: NO }>>;
  cleanupResult: ProtocolComposableSchema<Readonly<{ kind: 'confirmed' | 'retryable' }> | Readonly<{ kind: 'unknown'; code?: string }>>;
  result: ProtocolComposableSchema<MachineProvisionerAcquireResultV1<RI, NI>, MachineProvisionerAcquireResultV1<RO, NO>>;
}> = /* @__PURE__ */ projectProtocolValue(canonical.defineMachineProvisionerReconciliationSchemas);

/** Persistence-only reader; not an input, result or write-admission schema. */
export type MachineProvisionerStoredReaderV1<TOutput> = Readonly<{
  parse(value: unknown): TOutput;
  safeParse(value: unknown): ProtocolSchemaSafeParseResult<TOutput>;
}>;
export const prepareMachineProvisionerStoredSchemas: {
  <LI, LO, RI, RO, NI, NO>(schemas: Readonly<{
    launch: ProtocolComposableSchema<LI, LO>; resource: ProtocolComposableSchema<RI, RO>; nativeOperation: ProtocolComposableSchema<NI, NO>;
  }>): Promise<Readonly<{ launchStored: MachineProvisionerStoredReaderV1<LO>; resourceStored: MachineProvisionerStoredReaderV1<RO>; nativeOperationStored: MachineProvisionerStoredReaderV1<NO> }>>;
  <LI, LO, RI, RO>(schemas: Readonly<{
    launch: ProtocolComposableSchema<LI, LO>; resource: ProtocolComposableSchema<RI, RO>;
  }>): Promise<Readonly<{ launchStored: MachineProvisionerStoredReaderV1<LO>; resourceStored: MachineProvisionerStoredReaderV1<RO> }>>;
} = /* @__PURE__ */ projectProtocolValue(prepareCanonicalStoredSchemas);
