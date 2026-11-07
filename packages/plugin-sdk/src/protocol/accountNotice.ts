import { readOwnedNoticeArtifactV1 as canonicalReadOwnedNoticeArtifactV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { ServiceHealthNoticeSourceV1ProtocolSchema, ServiceHealthNoticePageV1ProtocolSchema,
    ServiceHealthNoticeMachineV1ProtocolSchema, type ServiceHealthNoticeMachineV1,
    type ServiceHealthNoticeSourceV1, type ServiceHealthNoticePageV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { DeploymentEnvironmentGetResultV1ProtocolSchema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { PluginActionResultById } from '../actions/actionTypeMap.generated.js';
import type { ProtocolComposableSchema } from './protocolFacade.js';
export type { ServiceHealthNoticeSourceV1, ServiceHealthNoticePageV1, ServiceHealthNoticeMachineV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';

/** The host source/page parsers remain the only identity and routing admission. */
export const ProtocolServiceHealthNoticeSourceV1Schema: ProtocolComposableSchema<ServiceHealthNoticeSourceV1> = ServiceHealthNoticeSourceV1ProtocolSchema;
export const ProtocolServiceHealthNoticePageV1Schema: ProtocolComposableSchema<ServiceHealthNoticePageV1> = ServiceHealthNoticePageV1ProtocolSchema;
export const ProtocolServiceHealthNoticeMachineV1Schema: ProtocolComposableSchema<ServiceHealthNoticeMachineV1> = ServiceHealthNoticeMachineV1ProtocolSchema;
export const ProtocolDeploymentEnvironmentGetResultV1Schema: ProtocolComposableSchema<PluginActionResultById['deployments.environments.get']> = DeploymentEnvironmentGetResultV1ProtocolSchema;

/** Authenticated Artifact transport facts, not notice-supplied identity. */
export type ProtocolNoticeArtifactV1 = Readonly<{
    ownerAccountId?: string;
    access?: string;
    publicAudience?: string;
    header?: unknown;
    body?: unknown;
}>;

/** Source and page need their domain's strict admission before use as operands. */
export type ProtocolOwnedNoticeV1 = Readonly<{
    v: 1;
    kind: 'account_notice.v1' | 'usage_notice.v1';
    title: string;
    status: 'open' | 'dismissed';
    source?: unknown;
    page?: unknown;
    type?: 'decision' | 'approval' | 'blocked' | 'update' | 'mention';
    resolved?: boolean;
    healthPhase?: 'open' | 'recovered';
    readAt?: number;
    body?: string;
    notice?: unknown;
}>;

/** The incumbent owner checks private audience, ownership and matching content. */
export const readOwnedNoticeArtifactV1: (
    artifact: ProtocolNoticeArtifactV1,
    accountId: string | null | undefined,
) => ProtocolOwnedNoticeV1 | null = canonicalReadOwnedNoticeArtifactV1;
