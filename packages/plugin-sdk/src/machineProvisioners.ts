/** @moduleRealm any */
import type { PluginJsonSchema, ProtocolComposableSchema, ProtocolJsonValue } from './protocol/protocolFacade.js';
import * as canonical from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { prepareMachineProvisionerStoredSchemas as prepareCanonicalStoredSchemas } from '@happier-dev/protocol/plugins/contributions/machineProvisionerStoredSchemas';
import type { ProtocolSchemaSafeParseResult } from './protocol/protocolFacade.js';
import { projectProtocolValue } from './protocol/projectProtocolValue.js';
import type { PluginProcessResult } from './services/io.js';
import type { PluginLocalizedStringV2 } from './manifest.js';
import type { InputPredicate } from './actions/dtos/pluginActionDtoSupport.generated.js';
import type { PluginActionResultById } from './actions/actionTypeMap.generated.js';
import type { PluginContributionRef } from './identity.js';
import type { AcquireResultV1, ManagedLocalResourceFactsV1, ManagedBootstrapCarrierV1, ProviderDeletionNoticeV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
export { MACHINE_PROVISIONER_NATIVE_STDERR_MAX_LENGTH_V1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
export { compareMachineHosts } from '@happier-dev/protocol/machines/host/normalizeMachineHost';

export type MachineProvisionerContributionV1 = Readonly<{
  id: string;
  title: PluginLocalizedStringV2;
  icon: string;
  resourceKind: string;
  enrollmentRole?: canonical.MachineProvisionerContributionV1['enrollmentRole'];
  /** Human kind and purpose; resourceKind remains native identity, never copy. */
  kindTitle?: PluginLocalizedStringV2;
  description?: PluginLocalizedStringV2;
  launchSchema: PluginJsonSchema;
  resourceSchema: PluginJsonSchema;
  schemaVersion: number;
  platforms: readonly ('darwin' | 'linux' | 'win32')[];
  /** Qualified whole browser API/bootstrap path; absence does not qualify browser acquisition. */
  browserReachable?: boolean;
  sessionPlacement?: canonical.MachineProvisionerContributionV1['sessionPlacement'];
  effectReview?: canonical.MachineProvisionerContributionV1['effectReview'];
  prerequisites: readonly Readonly<{ kind: 'managedDependency' | 'systemTool'; id: string | PluginContributionRef }>[];
  billing: Readonly<{ location: 'local' | 'cloud' | 'unknown'; stoppedBilling: 'billed' | 'not-billed' | 'unknown'; storageCharges?: readonly MachineProvisionerPriceV1[] }>;
  retention: Readonly<{ supportedIntents: readonly MachineProvisionerNativeIntentV1[]; guestLocalStop?: canonical.MachineProvisionerContributionV1['retention']['guestLocalStop']; finiteOnly?: boolean; deletionNotices?: readonly MachineProvisionerDeletionNoticeV1[]; nativeExpiry?: Readonly<{ kind: 'unused'; afterMs: number }> | Readonly<{ kind: 'deadline'; at: number }> }>;
  actions: canonical.MachineProvisionerContributionV1['actions'];
  resize?: canonical.MachineProvisionerContributionV1['resize'];
  snapshot?: canonical.MachineProvisionerContributionV1['snapshot'];
  /** Existing options Action field and its raw native input unit; not actual expiry. */
  nativeDurationInput?: Readonly<{ path: string; unit: 'milliseconds' | 'seconds' }>;
  /** Where the provider's own id lives in the resource value (the id its console shows); display only. */
  resourceIdPath?: string;
  bootstrapTransport?: canonical.MachineProvisionerContributionV1['bootstrapTransport'];
  bootstrapCredential?: Readonly<{ kind: 'ssh' | 'native-token' }>;
  nativeCredentialDelivery?: Readonly<{ apply: string; transports: readonly ['https_headers'];
    preservesEndpoint: true; perBindingMatching: true }>;
  /** Qualified native launch variants that do not require a declared purpose. */
  credentialPurposeRequirements?: readonly Readonly<{ purpose: string; optionalWhen: InputPredicate }>[];
  reconciliation?: Readonly<{ nativeOperationSchema: PluginJsonSchema; action: string; cleanup?: string; continueAcquire?: true }>;
  preparation?: canonical.MachineProvisionerContributionV1['preparation'];
}>;
export type MachineProvisionerNativeIntentV1 = 'start' | 'stop' | 'suspend' | 'resume' | 'delete' | 'rebuild';
export type MachineProvisionerPriceV1 = Readonly<{ label?: PluginLocalizedStringV2; amount: string; currency: string; unit: string; source: string; observedAt: number }>;
export type MachineProvisionerAuthorDefinitionV1 = Omit<MachineProvisionerContributionV1, 'id'>;
export type MachineProvisionerNativeCauseV1 = canonical.MachineProvisionerNativeCauseV1;
export type ManagedGuestCliBuildInputV1 = canonical.ManagedGuestCliBuildInputV1;
export type ManagedMachinePresetPreparationBuildInputV1 = canonical.ManagedMachinePresetPreparationBuildInputV1;
export const ManagedGuestCliBuildInputV1Schema: ProtocolComposableSchema<ManagedGuestCliBuildInputV1> = /* @__PURE__ */ projectProtocolValue(canonical.ManagedGuestCliBuildInputV1Schema);
export const ManagedMachinePresetPreparationBuildInputV1Schema: ProtocolComposableSchema<ManagedMachinePresetPreparationBuildInputV1> = /* @__PURE__ */ projectProtocolValue(canonical.ManagedMachinePresetPreparationBuildInputV1Schema);
export const createManagedMachinePresetPreparationBuildInputV1Schema: typeof canonical.createManagedMachinePresetPreparationBuildInputV1Schema = /* @__PURE__ */ projectProtocolValue(canonical.createManagedMachinePresetPreparationBuildInputV1Schema);
export type MachineProvisionerPreparationBuildInputV1 = canonical.MachineProvisionerPreparationBuildInputV1;
export type MachineProvisionerPreparationBuildResultV1 = canonical.MachineProvisionerPreparationBuildResultV1;
export type MachineProvisionerPreparationInspectInputV1 = canonical.MachineProvisionerPreparationInspectInputV1;
export type MachineProvisionerPreparationInspectResultV1 = canonical.MachineProvisionerPreparationInspectResultV1;
export type MachineProvisionerPreparationDestroyInputV1 = canonical.MachineProvisionerPreparationDestroyInputV1;
export type MachineProvisionerPreparationDestroyResultV1 = canonical.MachineProvisionerPreparationDestroyResultV1;
export const defineMachineProvisionerPreparationSchemas: typeof canonical.defineMachineProvisionerPreparationSchemas = /* @__PURE__ */ projectProtocolValue(canonical.defineMachineProvisionerPreparationSchemas);
export const MachineProvisionerPreparationBuildInputV1Schema: ProtocolComposableSchema<MachineProvisionerPreparationBuildInputV1> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerPreparationBuildInputV1Schema);
export const MachineProvisionerPreparationBuildResultV1Schema: ProtocolComposableSchema<MachineProvisionerPreparationBuildResultV1> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerPreparationBuildResultV1Schema);
export const MachineProvisionerPreparationInspectInputV1Schema: ProtocolComposableSchema<MachineProvisionerPreparationInspectInputV1> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerPreparationInspectInputV1Schema);
export const MachineProvisionerPreparationInspectResultV1Schema: ProtocolComposableSchema<MachineProvisionerPreparationInspectResultV1> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerPreparationInspectResultV1Schema);
export const MachineProvisionerPreparationDestroyInputV1Schema: ProtocolComposableSchema<MachineProvisionerPreparationDestroyInputV1> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerPreparationDestroyInputV1Schema);
export const MachineProvisionerPreparationDestroyResultV1Schema: ProtocolComposableSchema<MachineProvisionerPreparationDestroyResultV1> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerPreparationDestroyResultV1Schema);
export type MachineProvisionerSizeV1 = canonical.MachineProvisionerSizeV1;
export type MachineProvisionerSizeDimensionV1 = canonical.MachineProvisionerSizeDimensionV1;
export type MachineProvisionerResizeResultV1 = canonical.MachineProvisionerResizeResultV1;
export type MachineProvisionerSnapshotResultV1 = canonical.MachineProvisionerSnapshotResultV1;
export const MachineProvisionerSnapshotResultV1Schema: ProtocolComposableSchema<MachineProvisionerSnapshotResultV1> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerSnapshotResultV1Schema);
export const MACHINE_PROVISIONER_SIZE_DIMENSIONS_V1 = /* @__PURE__ */ projectProtocolValue(canonical.MACHINE_PROVISIONER_SIZE_DIMENSIONS_V1);
export const readMachineProvisionerResizeCapabilityV1 = /* @__PURE__ */ projectProtocolValue(canonical.readMachineProvisionerResizeCapabilityV1);
export const requiresMachineProvisionerEffectReviewV1 = /* @__PURE__ */ projectProtocolValue(canonical.requiresMachineProvisionerEffectReviewV1);
export const readMachineProvisionerResizeRequirementsV1 = /* @__PURE__ */ projectProtocolValue(canonical.readMachineProvisionerResizeRequirementsV1);
export const managedMachineResizeRequiresRestartV1 = /* @__PURE__ */ projectProtocolValue(canonical.managedMachineResizeRequiresRestartV1);
export const MachineProvisionerSizeV1Schema: ProtocolComposableSchema<MachineProvisionerSizeV1> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerSizeV1Schema);
export const MachineProvisionerResizeResultV1Schema: ProtocolComposableSchema<MachineProvisionerResizeResultV1> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerResizeResultV1Schema);
export type MachineProvisionerDeletionNoticeV1 = ProviderDeletionNoticeV1;

/** Neutral Action DTOs keep inferred author declarations independent of transitive Protocol type names. */
export type MachineProvisionerCheckResultV1 = Readonly<{ available: boolean; code?: string; nativeCause?: MachineProvisionerNativeCauseV1; status?: PluginLocalizedStringV2; nativeCredentialDelivery?: Readonly<{ status: 'supported' | 'unsupported' | 'unknown'; code?: string }>; prerequisites?: readonly Readonly<{ requirement: MachineProvisionerContributionV1['prerequisites'][number]; status: 'available' | 'unavailable' | 'unknown'; reason?: string; setupSources?: NonNullable<NonNullable<PluginActionResultById['machines.provisioners.check']['prerequisites']>[number]['setupSources']> & ProtocolJsonValue; repairAction?: Readonly<{ action: PluginContributionRef; input: ProtocolJsonValue }> }>[]; localResources?: ManagedLocalResourceFactsV1 }>;
export type MachineProvisionerNativeOptionFactsV1 = Readonly<{
  preparationGuest?: NonNullable<canonical.MachineProvisionerDimensionOptionV1['nativeFacts']>['preparationGuest'];
  size?: Readonly<{ id: string; title: PluginLocalizedStringV2; cpuCores?: number; memoryBytes?: number; diskBytes?: number }>;
  image?: Readonly<{ id: string; title: PluginLocalizedStringV2; description?: PluginLocalizedStringV2;
    preview?: Readonly<{ resource: PluginContributionRef; accessibilityLabel?: PluginLocalizedStringV2 }> }>;
  location?: Readonly<{ id: string; title: PluginLocalizedStringV2; countryCode?: string }>;
  network?: Readonly<{ id: string; title: PluginLocalizedStringV2 }>;
  duration?: Readonly<{ id: string; title: PluginLocalizedStringV2; afterMs: number; idleAfterMs?: number }>;
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
    prerequisites?: MachineProvisionerCheckResultV1['prerequisites'];
    unavailableReason?: MachineProvisionerDimensionOptionV1['unavailableReason'];
    guestPlatform?: MachineProvisionerDimensionOptionV1['guestPlatform'];
    enrollmentRole?: MachineProvisionerContributionV1['enrollmentRole'];
    billing?: MachineProvisionerContributionV1['billing'];
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
  unavailableReason?: Readonly<{ code: string; status: PluginLocalizedStringV2; fieldPath?: string }>;
  guestPlatform?: canonical.MachineProvisionerDimensionOptionV1['guestPlatform'];
  enrollmentRole?: MachineProvisionerContributionV1['enrollmentRole'];
  billing?: MachineProvisionerContributionV1['billing'];
  retention?: MachineProvisionerContributionV1['retention']; nativeFacts?: MachineProvisionerNativeOptionFactsV1;
}>;
export type MachineProvisionerSelectionProjectionV1 = Readonly<{
  prices: readonly MachineProvisionerPriceV1[]; nativeFacts: MachineProvisionerNativeOptionFactsV1;
  unavailableReason?: MachineProvisionerDimensionOptionV1['unavailableReason'];
  guestPlatform?: MachineProvisionerDimensionOptionV1['guestPlatform'];
  enrollmentRole?: MachineProvisionerContributionV1['enrollmentRole'];
  billing?: MachineProvisionerContributionV1['billing'];
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
  origin?: 'created';
  devcontainerObservation?: DevcontainerNativeObservationV1 }>;
export type MachineProvisionerRefusalCodeV1 = Extract<AcquireResultV1, { kind: 'rejected' }>['code'];
export type MachineProvisionerAcquireResultV1<TResource = ProtocolJsonValue, TNativeOperation = ProtocolJsonValue> = Readonly<{ kind: 'bound'; resource: MachineProvisionerResourceV1<TResource>; startPending?: true }> | Readonly<{ kind: 'pending'; nativeOperationRef: MachineProvisionerResourceV1<TNativeOperation>; nativeCause?: MachineProvisionerNativeCauseV1 }> | Readonly<{ kind: 'unknown'; recovery: Readonly<{ reference: string; reason: string; consoleUrl?: string }>; nativeCause?: MachineProvisionerNativeCauseV1 }> | Readonly<{ kind: 'rejected'; code: MachineProvisionerRefusalCodeV1; nativeCause?: MachineProvisionerNativeCauseV1 }>;
export type MachineProvisionerBootstrapCarrierV1 = ManagedBootstrapCarrierV1;
export type MachineProvisionerObservationV1 = Readonly<{ observedAt: number; availability: 'present' | 'absent' | 'unavailable'; power?: 'running' | 'stopped' | 'suspended' | 'unknown'; storage?: 'retained' | 'lost' | 'unknown'; size?: MachineProvisionerSizeV1; billing?: MachineProvisionerContributionV1['billing']; prices?: readonly MachineProvisionerPriceV1[]; nativeExpiry?: number; deletionNotices?: readonly MachineProvisionerDeletionNoticeV1[]; reason?: string; nativeCause?: MachineProvisionerNativeCauseV1 }>;
export type MachineProvisionerPowerResultV1 = Readonly<{ kind: 'confirmed' }> | Readonly<{ kind: 'unknown'; code?: string; nativeCause?: MachineProvisionerNativeCauseV1 }> | Readonly<{ kind: 'refused'; code: string; nativeCause?: MachineProvisionerNativeCauseV1 }>;
export type MachineProvisionerRenewResultV1 = canonical.MachineProvisionerRenewResultV1;
export type MachineProvisionerNativeCredentialBindingV1 = canonical.MachineProvisionerNativeCredentialBindingV1;
export type MachineProvisionerNativeCredentialApplyInputV1<TResource = ProtocolJsonValue> = canonical.MachineProvisionerNativeCredentialApplyInputV1<TResource>;
export type MachineProvisionerNativeCredentialApplyResultV1 = MachineProvisionerPowerResultV1;
export const MachineProvisionerNativeCredentialApplyInputV1Schema: ProtocolComposableSchema<MachineProvisionerNativeCredentialApplyInputV1> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerNativeCredentialApplyInputProtocolV1Schema);
export const MachineProvisionerNativeCredentialApplyResultV1Schema: ProtocolComposableSchema<MachineProvisionerNativeCredentialApplyResultV1> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerNativeCredentialApplyResultV1Schema);
export type MachineProvisionerDestroyResultV1<TNativeOperation = ProtocolJsonValue> = MachineProvisionerPowerResultV1
  | Readonly<{ kind: 'pending' }>
  | Readonly<{ kind: 'accepted'; nativeOperationRef: MachineProvisionerResourceV1<TNativeOperation> }>;
export type MachineProvisionerRebuildResultV1<TResource = ProtocolJsonValue> = Readonly<{ kind: 'bound'; resource: MachineProvisionerResourceV1<TResource> }>
  | Extract<MachineProvisionerAcquireResultV1<TResource>, { kind: 'unknown' }>
  | Readonly<{ kind: 'refused'; code: string; nativeCause?: MachineProvisionerNativeCauseV1 }>;
export const MachineProvisionerCheckInputV1Schema: ProtocolComposableSchema<Readonly<Record<string, never>>> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerCheckInputV1Schema);
export const MachineProvisionerNativeCauseV1Schema: ProtocolComposableSchema<MachineProvisionerNativeCauseV1> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerNativeCauseProtocolV1Schema);
export const MachineProvisionerCheckResultV1Schema: ProtocolComposableSchema<MachineProvisionerCheckResultV1> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerCheckResultProtocolV1Schema);
export const MachineProvisionerOptionsResultV1Schema: ProtocolComposableSchema<MachineProvisionerOptionsResultV1> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerOptionsResultProtocolV1Schema);
export const MachineProvisionerAcquireResultV1Schema: ProtocolComposableSchema<MachineProvisionerAcquireResultV1> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerAcquireResultV1Schema);
export const MachineProvisionerBootstrapCarrierV1Schema: ProtocolComposableSchema<MachineProvisionerBootstrapCarrierV1> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerBootstrapCarrierV1Schema);
export const MachineProvisionerObservationV1Schema: ProtocolComposableSchema<MachineProvisionerObservationV1> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerObservationV1Schema);
export const MachineProvisionerPowerResultV1Schema: ProtocolComposableSchema<MachineProvisionerPowerResultV1> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerPowerResultV1Schema);
export const MachineProvisionerRenewResultV1Schema: ProtocolComposableSchema<MachineProvisionerRenewResultV1> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerRenewResultV1Schema);
export const MachineProvisionerDestroyResultV1Schema: ProtocolComposableSchema<MachineProvisionerDestroyResultV1> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerDestroyResultV1Schema);
export const MachineProvisionerRebuildResultV1Schema: ProtocolComposableSchema<MachineProvisionerRebuildResultV1> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerRebuildResultV1Schema);
export const MachineProvisionerPutFileResultV1Schema: ProtocolComposableSchema<MachineProvisionerPowerResultV1> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerPutFileResultV1Schema);
export type MachineProvisionerNativeExecResultV1 = (Omit<PluginProcessResult, 'stdout' | 'stderr'> & Readonly<{ stdoutBase64: string; stderrBase64: string }>)
  | Readonly<{ kind: 'process-configured' }>;
export type MachineProvisionerProcessConfigV1 = canonical.MachineProvisionerProcessConfigV1;
export const MachineProvisionerNativeExecResultV1Schema: ProtocolComposableSchema<MachineProvisionerNativeExecResultV1> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerNativeExecResultV1Schema);
/** The `stream` role's result: how the channel's local carrier ended, never proof that the guest process exited. */
export type MachineProvisionerNativeStreamResultV1 = Readonly<{ termination: PluginProcessResult['termination'] }>;
export const MachineProvisionerNativeStreamResultV1Schema: ProtocolComposableSchema<MachineProvisionerNativeStreamResultV1> = /* @__PURE__ */ projectProtocolValue(canonical.MachineProvisionerNativeStreamResultV1Schema);
export type MachineProvisionerGuestHomeV1 = canonical.MachineProvisionerGuestHomeV1;
export const defineMachineProvisionerSchemas: <LI, LO, RI, RO, C extends true | undefined = undefined>(schemas: Readonly<{ launch: ProtocolComposableSchema<LI, LO>; resource: ProtocolComposableSchema<RI, RO>; continueAcquire?: C }>) => Readonly<{
  checkInput: typeof MachineProvisionerCheckInputV1Schema;
  nativeCredentialApplyInput: ProtocolComposableSchema<MachineProvisionerNativeCredentialApplyInputV1<RI>, MachineProvisionerNativeCredentialApplyInputV1<RO>>;
  acquireInput: ProtocolComposableSchema<Readonly<{ launch: LI; managedId?: string; bootstrapPublicKey?: string; guestHostPublicKey?: string; guestHome?: MachineProvisionerGuestHomeV1; reviewedEffectDigest?: string }> & (C extends true ? Readonly<{ resource?: RI }> : {}),
    Readonly<{ launch: LO; managedId?: string; bootstrapPublicKey?: string; guestHostPublicKey?: string; guestHome?: MachineProvisionerGuestHomeV1; reviewedEffectDigest?: string }> & (C extends true ? Readonly<{ resource?: RO }> : {})>;
  acquireResult: ProtocolComposableSchema<Exclude<MachineProvisionerAcquireResultV1<RI>, { kind: 'pending' }>, Exclude<MachineProvisionerAcquireResultV1<RO>, { kind: 'pending' }>>;
  rebuildInput: ProtocolComposableSchema<Readonly<{ resource: RI; reviewedEffectDigest: string; guestHome?: MachineProvisionerGuestHomeV1 }>, Readonly<{ resource: RO; reviewedEffectDigest: string; guestHome?: MachineProvisionerGuestHomeV1 }>>;
  rebuildResult: ProtocolComposableSchema<MachineProvisionerRebuildResultV1<RI>, MachineProvisionerRebuildResultV1<RO>>;
  resizeInput: ProtocolComposableSchema<Readonly<{ resource: RI; size: MachineProvisionerSizeV1 }>, Readonly<{ resource: RO; size: MachineProvisionerSizeV1 }>>;
  snapshotInput: ProtocolComposableSchema<Readonly<{ resource: RI; expectedMachineRevision: number; label: string; reason: string }>, Readonly<{ resource: RO; expectedMachineRevision: number; label: string; reason: string }>>;
  bootstrapInput: ProtocolComposableSchema<Readonly<{ resource: RI; credentialRef?: Readonly<{ kind: 'shared_resource'; resourceId: string }>; bootstrapPublicKey?: string; guestHostPublicKey?: string }>, Readonly<{ resource: RO; credentialRef?: Readonly<{ kind: 'shared_resource'; resourceId: string }>; bootstrapPublicKey?: string; guestHostPublicKey?: string }>>;
  resourceInput: ProtocolComposableSchema<Readonly<{ resource: RI }>, Readonly<{ resource: RO }>>;
  renewInput: ProtocolComposableSchema<Readonly<{ resource: RI; deadlineAt?: number }>, Readonly<{ resource: RO; deadlineAt?: number }>>;
  powerInput: ProtocolComposableSchema<Readonly<{ resource: RI; intent: MachineProvisionerNativeIntentV1 }>, Readonly<{ resource: RO; intent: MachineProvisionerNativeIntentV1 }>>;
  execInput: ProtocolComposableSchema<Readonly<{ resource: RI; argv: readonly string[]; allowWake?: false; inputBase64?: string; timeoutMs?: number | null; processConfig?: MachineProvisionerProcessConfigV1 }>, Readonly<{ resource: RO; argv: readonly string[]; allowWake?: false; inputBase64?: string; timeoutMs?: number | null; processConfig?: MachineProvisionerProcessConfigV1 }>>;
  /** One bounded fragment at a host-selected private path. Host assembly owns
   * atomic publication of the complete archive; confirmed means all bytes of
   * this fragment were written, including native process settlement. */
  putFileInput: ProtocolComposableSchema<Readonly<{ resource: RI; guestPath: string; allowWake?: false; bytesBase64: string; mode?: number }>, Readonly<{ resource: RO; guestPath: string; allowWake?: false; bytesBase64: string; mode?: number }>>;
  /** Optional long-lived non-PTY duplex channel for one argv: spawn it with
   * `outputDelivery: 'invocation'` and return its termination when it ends. */
  streamInput: ProtocolComposableSchema<Readonly<{ resource: RI; argv: readonly string[] }>, Readonly<{ resource: RO; argv: readonly string[] }>>;
}> = /* @__PURE__ */ projectProtocolValue(canonical.defineMachineProvisionerSchemas);

/** Use this result on both acquire and the declared read-only reconciliation Action.
 * Reconciliation observes retained immutable submission facts or the returned
 * identity; it must never submit/replay an allocation, including under a native
 * idempotency key. Missing read evidence is unknown, never confirmed absence.
 */
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
