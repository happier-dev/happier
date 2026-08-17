/**
 * Exact final `/providers` author projection.
 *
 * Canonical Provider declarations and result identities stay Protocol-owned.
 * This module removes only host-owned ambient request fields and composes the
 * SDK-owned registration, managed-runtime, and service contracts. Publication
 * remains owned by the normal-surface export gate.
 */
import type {
    DaemonProviderBindingStatusRequestV1,
    DaemonProviderBindingStatusResponseV1,
    DaemonProviderConnectionMutationRequestV1,
    DaemonProviderConnectionMutationResponseV1,
    DaemonProviderConnectionsDescribeRequestV1,
    DaemonProviderConnectionsDescribeResponseV1,
    DaemonProviderModelLoadRequestV1,
    DaemonProviderModelLoadResponseV1,
    DaemonProviderModelProjectionRequestV1,
    DaemonProviderModelProjectionResponseV1,
    DaemonProviderModelsRequestV1,
    DaemonProviderModelsResponseV1,
    DaemonProviderModelSettingsMutationRequestV1,
    DaemonProviderModelSettingsMutationResponseV1,
    DaemonProviderProbeRequestV1,
    DaemonProviderProbeResponseV1,
    DaemonProviderProfileMigrationConfirmRequestV1,
    DaemonProviderProfileMigrationConfirmResponseV1,
    DaemonProviderProfileMigrationConflictConfirmRequestV1,
    DaemonProviderProfileMigrationConflictConfirmResponseV1,
    DaemonProviderProfileMigrationPreviewRequestV1,
    DaemonProviderProfileMigrationPreviewResponseV1,
} from '@happier-dev/protocol/rpc';
import {
    resolveSessionModelSelectionIntentV1 as canonicalResolveSessionModelSelectionIntentV1,
} from '@happier-dev/protocol/providers/model-selection';
import {
    resolveProviderBindingCompatibilityWithFingerprintV1 as canonicalResolveProviderBindingCompatibilityWithFingerprintV1,
} from '@happier-dev/protocol/providers/binding-compatibility';
import type {
    ResolveProviderBindingCompatibilityInputV1,
} from '@happier-dev/protocol/providers/binding-compatibility';
import {
    ProviderContributionV1Schema as canonicalProviderContributionV1Schema,
} from '@happier-dev/protocol/providers/contributions';
import type {
    ProviderContributionV1,
} from '@happier-dev/protocol/providers/contributions';
export type {
    ResolveProviderBindingCompatibilityInputV1,
} from '@happier-dev/protocol/providers/binding-compatibility';
export type {
    AgentProviderRequirementsV1,
} from '@happier-dev/protocol/providers/binding-compatibility';
import type { PluginCancellationOptions } from '../lifecycle.js';

export {
    areProviderContributionKeysEqualV1,
} from '@happier-dev/protocol/providers/contribution-identity';
export {
    containsProviderRegisteredSensitiveValue,
} from '@happier-dev/protocol/providers/sensitive-value-redaction';
export {
    normalizeProviderCredentialHeaderName,
} from '@happier-dev/protocol/providers/credential-headers';
export {
    ProviderConnectionIdSchema,
} from '@happier-dev/protocol/providers/ids';
export type {
    ProviderConnectionId,
} from '@happier-dev/protocol/providers/ids';
export const ProviderContributionV1Schema: Readonly<{
    parse(value: unknown): ProviderContributionV1;
    safeParse(value: unknown):
        | Readonly<{ success: true; data: ProviderContributionV1 }>
        | Readonly<{ success: false; error: unknown }>;
}> = canonicalProviderContributionV1Schema;
export {
    ProviderEndpointUrlSyntaxSchema,
} from '@happier-dev/protocol/providers/endpoint-url';
export {
    ProviderPublicHeadersV1Schema,
} from '@happier-dev/protocol/providers/public-headers';
export {
    SessionModelSelectionResolutionError,
    SessionModelSelectionV1Schema,
} from '@happier-dev/protocol/providers/model-selection';
export type {
    SessionModelSelectionResolutionErrorCode,
} from '@happier-dev/protocol/providers/model-selection';

export type ProviderBindingCompatibilityResolutionInput =
    ResolveProviderBindingCompatibilityInputV1 & Readonly<{
        adapterVersion: number;
    }>;

export const resolveProviderBindingCompatibilityWithFingerprintV1: (
    input: ProviderBindingCompatibilityResolutionInput,
) => ReturnType<typeof canonicalResolveProviderBindingCompatibilityWithFingerprintV1> =
    canonicalResolveProviderBindingCompatibilityWithFingerprintV1;

export type SessionModelSelectionIntentResolutionInput = Readonly<{
    canonical: unknown;
    legacy: unknown;
    agentTargetKey: string;
}>;

export const resolveSessionModelSelectionIntentV1: (
    input: SessionModelSelectionIntentResolutionInput,
) => ReturnType<typeof canonicalResolveSessionModelSelectionIntentV1> =
    canonicalResolveSessionModelSelectionIntentV1;

export type {
    CapabilitySupport as ProviderCapabilitySupport,
    ProviderApiKeyCredentialRequirementV1,
    ProviderCatalogCommandFallbackV1,
    ProviderCatalogDeclarationV1,
    ProviderCatalogParserV1,
    ProviderCatalogProbeV1,
    ProviderCompatibilityCapabilitiesV1,
    ProviderCompatibilityOverrideV1,
    ProviderContributionV1 as ProviderContribution,
    ProviderCredentialDestinationV1,
    ProviderCredentialFormatV1,
    ProviderCredentialTransportV1,
    ProviderDetectionDescriptorV1,
    ProviderEndpointTemplateV1,
    ProviderLegacyProfileMigrationDescriptorV1,
    ProviderManagedRuntimeDeclarationV1 as ProviderManagedRuntimeDeclaration,
    ProviderModelLoadDescriptorV1,
    ProviderWireProtocol,
} from '@happier-dev/protocol/providers';

/** @realm daemon */
export type {
    ManagedProviderEndpoint,
    ManagedProviderRuntime,
    ManagedProviderRuntimeContext,
    ManagedProviderStartRequest,
    ProviderLocalId,
    ProvidersRegistrationApi,
} from '../managed-services/contract.js';

declare const canonicalProviderConnectionsDescribeRequest: DaemonProviderConnectionsDescribeRequestV1;
declare const canonicalProviderConnectionMutationRequest: DaemonProviderConnectionMutationRequestV1;
declare const canonicalProviderBindingStatusRequest: DaemonProviderBindingStatusRequestV1;
declare const canonicalProviderProbeRequest: DaemonProviderProbeRequestV1;
declare const canonicalProviderModelsRequest: DaemonProviderModelsRequestV1;
declare const canonicalProviderModelLoadRequest: DaemonProviderModelLoadRequestV1;
declare const canonicalProviderModelProjectionRequest: DaemonProviderModelProjectionRequestV1;
declare const canonicalProviderModelSettingsMutationRequest: DaemonProviderModelSettingsMutationRequestV1;
declare const canonicalProviderProfileMigrationPreviewRequest: DaemonProviderProfileMigrationPreviewRequestV1;
declare const canonicalProviderProfileMigrationConfirmRequest: DaemonProviderProfileMigrationConfirmRequestV1;
declare const canonicalProviderProfileMigrationConflictConfirmRequest: DaemonProviderProfileMigrationConflictConfirmRequestV1;

/** @realm daemon */
export type ProviderConnectionsDescribeRequest =
    typeof canonicalProviderConnectionsDescribeRequest extends infer TRequest
        ? TRequest extends Readonly<{ machineId: unknown }>
            ? Omit<TRequest, 'machineId'>
            : never
        : never;
/** @realm daemon */
export type ProviderConnectionsDescribeResult =
    DaemonProviderConnectionsDescribeResponseV1;
/** @realm daemon */
export type ProviderConnectionMutationRequest =
    | (Exclude<
          typeof canonicalProviderConnectionMutationRequest,
          Extract<
              typeof canonicalProviderConnectionMutationRequest,
              { action: 'startLocal' }
          >
      > extends infer TRequest
          ? TRequest extends Readonly<{ machineId: unknown }>
              ? Omit<TRequest, 'machineId'>
              : never
          : never)
    | Readonly<Omit<
        Extract<
            typeof canonicalProviderConnectionMutationRequest,
            { action: 'startLocal' }
        >,
        'machineId' | 'connectionId'
    >>;
/** @realm daemon */
export type ProviderConnectionMutationResult =
    DaemonProviderConnectionMutationResponseV1;
/** @realm daemon */
export type ProviderBindingStatusRequest =
    typeof canonicalProviderBindingStatusRequest extends infer TRequest
        ? TRequest extends Readonly<{ machineId: unknown }>
            ? Omit<TRequest, 'machineId'>
            : never
        : never;
/** @realm daemon */
export type ProviderBindingStatusResult = DaemonProviderBindingStatusResponseV1;
/** @realm daemon */
export type ProviderProbeRequest =
    typeof canonicalProviderProbeRequest extends infer TRequest
        ? TRequest extends Readonly<{ machineId: unknown }>
            ? Omit<TRequest, 'machineId'>
            : never
        : never;
/** @realm daemon */
export type ProviderProbeResult = DaemonProviderProbeResponseV1;
/** @realm daemon */
export type ProviderModelsRequest =
    typeof canonicalProviderModelsRequest extends infer TRequest
        ? TRequest extends Readonly<{ machineId: unknown }>
            ? Omit<TRequest, 'machineId'>
            : never
        : never;
/** @realm daemon */
export type ProviderModelsResult = DaemonProviderModelsResponseV1;
/** @realm daemon */
export type ProviderModelLoadRequest =
    typeof canonicalProviderModelLoadRequest extends infer TRequest
        ? TRequest extends Readonly<{ machineId: unknown }>
            ? Omit<TRequest, 'machineId'>
            : never
        : never;
/** @realm daemon */
export type ProviderModelLoadResult = DaemonProviderModelLoadResponseV1;
/** @realm daemon */
export type ProviderModelProjectionRequest =
    typeof canonicalProviderModelProjectionRequest extends infer TRequest
        ? TRequest extends Readonly<{ machineId: unknown }>
            ? Omit<TRequest, 'machineId'>
            : never
        : never;
/** @realm daemon */
export type ProviderModelProjectionResult = DaemonProviderModelProjectionResponseV1;
/** @realm daemon */
export type ProviderModelSettingsMutationRequest =
    typeof canonicalProviderModelSettingsMutationRequest extends infer TRequest
        ? TRequest extends Readonly<{ machineId: unknown }>
            ? Omit<TRequest, 'machineId'>
            : never
        : never;
/** @realm daemon */
export type ProviderModelSettingsMutationResult =
    DaemonProviderModelSettingsMutationResponseV1;
/** @realm daemon */
export type ProviderProfileMigrationPreviewRequest =
    typeof canonicalProviderProfileMigrationPreviewRequest extends infer TRequest
        ? TRequest extends Readonly<{ machineId: unknown }>
            ? Omit<TRequest, 'machineId'>
            : never
        : never;
/** @realm daemon */
export type ProviderProfileMigrationPreviewResult =
    DaemonProviderProfileMigrationPreviewResponseV1;
/** @realm daemon */
export type ProviderProfileMigrationConfirmRequest =
    typeof canonicalProviderProfileMigrationConfirmRequest extends infer TRequest
        ? TRequest extends Readonly<{ machineId: unknown }>
            ? Omit<TRequest, 'machineId'>
            : never
        : never;
/** @realm daemon */
export type ProviderProfileMigrationConfirmResult =
    DaemonProviderProfileMigrationConfirmResponseV1;
/** @realm daemon */
export type ProviderProfileMigrationConflictConfirmRequest =
    typeof canonicalProviderProfileMigrationConflictConfirmRequest extends infer TRequest
        ? TRequest extends Readonly<{ machineId: unknown }>
            ? Omit<TRequest, 'machineId'>
            : never
        : never;
/** @realm daemon */
export type ProviderProfileMigrationConflictConfirmResult =
    DaemonProviderProfileMigrationConflictConfirmResponseV1;

/** @realm daemon */
export interface ProviderConnectionsService {
    describe(
        request: ProviderConnectionsDescribeRequest,
        options?: PluginCancellationOptions,
    ): Promise<ProviderConnectionsDescribeResult>;
    mutate(
        request: ProviderConnectionMutationRequest,
        options?: PluginCancellationOptions,
    ): Promise<ProviderConnectionMutationResult>;
    bindingStatus(
        request: ProviderBindingStatusRequest,
        options?: PluginCancellationOptions,
    ): Promise<ProviderBindingStatusResult>;
}

/** @realm daemon */
export interface ProviderCatalogService {
    probe(
        request: ProviderProbeRequest,
        options?: PluginCancellationOptions,
    ): Promise<ProviderProbeResult>;
    listModels(
        request: ProviderModelsRequest,
        options?: PluginCancellationOptions,
    ): Promise<ProviderModelsResult>;
    setModelLoad(
        request: ProviderModelLoadRequest,
        options?: PluginCancellationOptions,
    ): Promise<ProviderModelLoadResult>;
    projectModels(
        request: ProviderModelProjectionRequest,
        options?: PluginCancellationOptions,
    ): Promise<ProviderModelProjectionResult>;
    mutateModelSettings(
        request: ProviderModelSettingsMutationRequest,
        options?: PluginCancellationOptions,
    ): Promise<ProviderModelSettingsMutationResult>;
}

/** @realm daemon */
export interface ProviderMigrationsService {
    preview(
        request: ProviderProfileMigrationPreviewRequest,
        options?: PluginCancellationOptions,
    ): Promise<ProviderProfileMigrationPreviewResult>;
    confirm(
        request: ProviderProfileMigrationConfirmRequest,
        options?: PluginCancellationOptions,
    ): Promise<ProviderProfileMigrationConfirmResult>;
    confirmConflict(
        request: ProviderProfileMigrationConflictConfirmRequest,
        options?: PluginCancellationOptions,
    ): Promise<ProviderProfileMigrationConflictConfirmResult>;
}

/** @realm daemon */
export interface ProvidersService {
    readonly connections: ProviderConnectionsService;
    readonly catalog: ProviderCatalogService;
    readonly migrations: ProviderMigrationsService;
}
