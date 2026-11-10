import type { ReadonlyAuthorDeclaration } from './definePlugin.js';
import type { PluginJsonSchemaV2 } from './actions/actionTypeMap.generated.js';
import type { PluginLocalizedStringV2 } from './manifest.js';
import type { ProtocolComposableSchema } from './protocol/protocolFacade.js';
import type { PluginCancellationOptions } from './lifecycle.js';
import type { HealthCheckKindCatalogV1 } from '@happier-dev/protocol/plugins/contributions/healthCheckKinds';
export type { HealthCheckKindCatalogV1 } from '@happier-dev/protocol/plugins/contributions/healthCheckKinds';
export { HealthCheckKindCatalogV1ProtocolSchema } from '@happier-dev/protocol/plugins/contributions/healthCheckKinds';
export type { HealthCheckSourceSelectorV1 } from '@happier-dev/protocol/deployments/healthCheckSourceV1';
export { HealthCheckSourceSelectorV1ProtocolSchema } from '@happier-dev/protocol/deployments/healthCheckSourceV1';
export type { HealthCheckDomainSetupIntentV1 } from '@happier-dev/protocol/deployments/healthCheckSourceV1';
export { HealthCheckDomainSetupIntentV1ProtocolSchema } from '@happier-dev/protocol/deployments/healthCheckSourceV1';
import type { PluginWebhookHeartbeatManageInputV1, PluginWebhookHeartbeatManageResultV1 } from '@happier-dev/protocol/plugins/webhooks/endpointV1';
export type { PluginWebhookHeartbeatManageInputV1, PluginWebhookHeartbeatManageResultV1 } from '@happier-dev/protocol/plugins/webhooks/endpointV1';
export { PluginWebhookHeartbeatManageInputV1ProtocolSchema, PluginWebhookHeartbeatManageResultV1ProtocolSchema } from '@happier-dev/protocol/plugins/webhooks/endpointV1';
import {
    HealthCheckSubjectV1ProtocolSchema as canonicalSubject,
    HealthCheckResultV1ProtocolSchema as canonicalResult,
    HealthCheckSourceConfigV1ProtocolSchema as canonicalSourceConfig,
    HealthCheckSetupInputV1ProtocolSchema as canonicalSetupInput,
    HealthCheckSetupDraftV1ProtocolSchema as canonicalSetupDraft,
    HealthCheckHttpConfigV1ProtocolSchema as canonicalHttpConfig,
    HealthCheckTransitionV1ProtocolSchema as canonicalTransition,
    SavedHealthCheckSelectorV1ProtocolSchema as canonicalSelector,
    HealthCheckTcpConfigV1ProtocolSchema as canonicalTcpConfig,
    HealthCheckDnsConfigV1ProtocolSchema as canonicalDnsConfig,
    HealthCheckHeartbeatConfigV1ProtocolSchema as canonicalHeartbeatConfig,
} from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import type {
    HealthCheckSubjectV1,
    HealthCheckResultV1,
    HealthCheckSourceConfigV1,
    HealthCheckSetupInputV1,
    HealthCheckSetupDraftV1,
    HealthCheckHttpConfigV1,
    HealthCheckTransitionV1,
    SavedHealthCheckSelectorV1,
    HealthCheckTcpConfigV1,
    HealthCheckDnsConfigV1,
    HealthCheckHeartbeatConfigV1,
} from '@happier-dev/protocol/activity/usageNoticeArtifactV1';

/** Unreleased declaration contract; execution remains at the referenced Action. */
export type HealthCheckKindContributionV1 = Readonly<{
    id: string;
    title: ReadonlyAuthorDeclaration<PluginLocalizedStringV2>;
    description?: ReadonlyAuthorDeclaration<PluginLocalizedStringV2>;
    configSchema: ReadonlyAuthorDeclaration<PluginJsonSchemaV2>;
    action: string;
}>;

export { HEALTH_CHECK_KINDS_V1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
export { HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
export { HEALTH_CHECK_EVENT_REFS_V1, HEALTH_CHECK_SETUP_OPEN_ACTION_REF_V1 } from '@happier-dev/protocol/deployments/healthCheckV1';
export { createHealthCheckSourceInstanceIdV1 } from '@happier-dev/protocol/deployments/healthCheckSubjectV1';
export { isHealthCheckLoopbackRefusedV1 } from '@happier-dev/protocol/deployments/healthCheckSourceV1';
export type { HealthCheckSetupInputV1, HealthCheckSetupDraftV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
export const HealthCheckSetupInputV1ProtocolSchema: ProtocolComposableSchema<HealthCheckSetupInputV1> = canonicalSetupInput;
export const HealthCheckSetupDraftV1ProtocolSchema: ProtocolComposableSchema<HealthCheckSetupDraftV1> = canonicalSetupDraft;
export const HealthCheckHttpConfigV1ProtocolSchema: ProtocolComposableSchema<HealthCheckHttpConfigV1> = canonicalHttpConfig;
export const HealthCheckTcpConfigV1ProtocolSchema: ProtocolComposableSchema<HealthCheckTcpConfigV1> = canonicalTcpConfig;
export const HealthCheckDnsConfigV1ProtocolSchema: ProtocolComposableSchema<HealthCheckDnsConfigV1> = canonicalDnsConfig;
export const HealthCheckHeartbeatConfigV1ProtocolSchema: ProtocolComposableSchema<HealthCheckHeartbeatConfigV1> = canonicalHeartbeatConfig;
export type { HealthCheckKindV1, HealthCheckStatusV1, HealthCheckSubjectV1, HealthCheckResultV1, HealthCheckSourceConfigV1, SavedHealthCheckSelectorV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
export const HealthCheckSubjectV1ProtocolSchema: ProtocolComposableSchema<HealthCheckSubjectV1> = canonicalSubject;
export const HealthCheckResultV1ProtocolSchema: ProtocolComposableSchema<HealthCheckResultV1> = canonicalResult;
export const HealthCheckSourceConfigV1ProtocolSchema: ProtocolComposableSchema<HealthCheckSourceConfigV1> = canonicalSourceConfig;
export const HealthCheckTransitionV1ProtocolSchema: ProtocolComposableSchema<HealthCheckTransitionV1> = canonicalTransition;
export const SavedHealthCheckSelectorV1ProtocolSchema: ProtocolComposableSchema<SavedHealthCheckSelectorV1> = canonicalSelector;

/** @realm daemon
 * Finite reads of admitted saved selectors, never caller-supplied endpoints.
 */
export interface HealthChecksService {
    /** Current kind declarations; the referenced Action retains ordinary invocation policy. */
    listKinds(options?: PluginCancellationOptions): Promise<HealthCheckKindCatalogV1>;
    /** Read the current adopted source of the canonical saved-check observer. */
    readSource(input: Readonly<{ sourceInstanceId: string }>, options?: PluginCancellationOptions): Promise<HealthCheckSourceConfigV1>;
    /** Control an exact saved heartbeat without disclosing its secret address. */
    manageHeartbeat(input: PluginWebhookHeartbeatManageInputV1, options?: PluginCancellationOptions): Promise<PluginWebhookHeartbeatManageResultV1>;
    /** Explicit setup enrolls declared capability endpoints; saved config retains only nonsecret identities. */
    setup(input: Readonly<{ sourceInstanceId: string; sourceConfig: HealthCheckSetupInputV1;
        heartbeatContributionId: string;
        capabilityWebhookContributions?: Readonly<Record<string, string>> }>, options?: PluginCancellationOptions): Promise<HealthCheckSourceConfigV1>;
    read(input: Readonly<{ sourceInstanceId: string; checkIds: readonly string[] }>, options?: PluginCancellationOptions):
        Promise<readonly Readonly<{ checkId: string; result: HealthCheckResultV1;
            /** Absolute producer deadline; null waits for an authenticated receipt. */
            nextEligibleAt?: number | null }>[]>;
}

export type { HealthCheckDnsConfigV1, HealthCheckHeartbeatConfigV1, HealthCheckTcpConfigV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
