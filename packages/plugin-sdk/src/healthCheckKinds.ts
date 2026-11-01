import type { ReadonlyAuthorDeclaration } from './definePlugin.js';
import type { PluginJsonSchemaV2 } from './actions/actionTypeMap.generated.js';
import type { PluginLocalizedStringV2 } from './manifest.js';
import type { ProtocolComposableSchema } from './protocol/protocolFacade.js';
import type { PluginCancellationOptions } from './lifecycle.js';
import {
    HealthCheckSubjectV1ProtocolSchema as canonicalSubject,
    HealthCheckResultV1ProtocolSchema as canonicalResult,
    HealthCheckSourceConfigV1ProtocolSchema as canonicalSourceConfig,
    SavedHealthCheckSelectorV1ProtocolSchema as canonicalSelector,
    HealthCheckTcpConfigV1ProtocolSchema as canonicalTcpConfig,
    HealthCheckDnsConfigV1ProtocolSchema as canonicalDnsConfig,
    HealthCheckHeartbeatConfigV1ProtocolSchema as canonicalHeartbeatConfig,
} from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import type {
    HealthCheckSubjectV1,
    HealthCheckResultV1,
    HealthCheckSourceConfigV1,
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
export const HealthCheckTcpConfigV1ProtocolSchema: ProtocolComposableSchema<HealthCheckTcpConfigV1> = canonicalTcpConfig;
export const HealthCheckDnsConfigV1ProtocolSchema: ProtocolComposableSchema<HealthCheckDnsConfigV1> = canonicalDnsConfig;
export const HealthCheckHeartbeatConfigV1ProtocolSchema: ProtocolComposableSchema<HealthCheckHeartbeatConfigV1> = canonicalHeartbeatConfig;
export type { HealthCheckKindV1, HealthCheckStatusV1, HealthCheckSubjectV1, HealthCheckResultV1, HealthCheckSourceConfigV1, SavedHealthCheckSelectorV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
export const HealthCheckSubjectV1ProtocolSchema: ProtocolComposableSchema<HealthCheckSubjectV1> = canonicalSubject;
export const HealthCheckResultV1ProtocolSchema: ProtocolComposableSchema<HealthCheckResultV1> = canonicalResult;
export const HealthCheckSourceConfigV1ProtocolSchema: ProtocolComposableSchema<HealthCheckSourceConfigV1> = canonicalSourceConfig;
export const SavedHealthCheckSelectorV1ProtocolSchema: ProtocolComposableSchema<SavedHealthCheckSelectorV1> = canonicalSelector;

/** @realm daemon
 * Finite reads of admitted saved selectors, never caller-supplied endpoints.
 */
export interface HealthChecksService {
    /** Explicit setup enrolls record-only endpoints; sourceConfig keeps only their nonsecret identities. */
    setup(input: Readonly<{ sourceInstanceId: string; sourceConfig: HealthCheckSourceConfigV1;
        heartbeatContributionId: string }>, options?: PluginCancellationOptions): Promise<HealthCheckSourceConfigV1>;
    read(input: Readonly<{ sourceInstanceId: string; checkIds: readonly string[] }>, options?: PluginCancellationOptions):
        Promise<readonly Readonly<{ checkId: string; result: HealthCheckResultV1;
            /** Absolute producer deadline; null waits for an authenticated receipt. */
            nextEligibleAt?: number | null }>[]>;
}

