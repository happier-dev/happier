import {
    defineContributionPoint,
    defineContributionProtocol,
    type ContributionAdmittedEntry,
    type ContributionProtocol,
    type TargetedContributionPointRef,
} from '@happier-dev/plugin-sdk/contributions';

import {
    CONVERSATION_CORE_PLUGIN_ID_V1,
    CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_ID_V1,
    CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_ID_V1,
    CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_VERSION_V1,
} from '../bounds.js';
import {
    ConversationProviderAutomationEventAdmitInputV1Schema,
    ConversationProviderAutomationEventAdmitResultV1Schema,
} from './automationEvents.js';
import {
    ConversationDeliveryInputV1Schema,
    ConversationDeliveryReconcileInputV1Schema,
    ConversationDeliveryResultV1Schema,
} from './delivery.js';
import {
    ConversationConnectionTestInputV1Schema,
    ConversationConnectionTestResultV1Schema,
    ConversationProviderConnectionStopInputV1Schema,
    ConversationProviderConnectionStopResultV1Schema,
} from './lifecycle.js';
import {
    ConversationPollInputV1Schema,
    ConversationPollResultV1Schema,
} from './observations.js';
import {
    ConversationEndpointResolveInputV1Schema,
    ConversationEndpointResolveResultV1Schema,
    ConversationPrincipalResolveInputV1Schema,
    ConversationPrincipalResolveResultV1Schema,
} from './resolution.js';
import {
    ConversationProviderSetupOutcomeV1Schema,
    ConversationProviderSetupRemediationResultV1Schema,
} from './setup.js';
import { ConversationAttachmentFetchInputV1Schema, ConversationAttachmentFetchResultV1Schema } from './attachments.js';
import { ConversationProviderDescriptorV1Schema } from './descriptor.js';

/**
 * The V1 provider presentation and role contract. Its arbitrary provider-local
 * Action bindings are admitted by the generic target-owner lifecycle.
 */
export const ConversationProvidersContributionProtocolV1 = defineContributionProtocol({
    id: CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_ID_V1,
    version: CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_VERSION_V1,
    descriptor: ConversationProviderDescriptorV1Schema,
    operations: {
        setup: {
            required: true,
            input: { kind: 'contributorDefined' },
            resultSchema: ConversationProviderSetupOutcomeV1Schema,
            action: { surfaces: ['plugin', 'ui'], dangerLevel: 'safe' },
        },
        /**
         * Optional, provider-owned remote remediation for a safe setup result
         * that returned `requiresRemediation`. It deliberately keeps its input
         * contributor-defined: an external provider may require a fresh
         * selected Connected Account or provider-specific setup context, and
         * the host-owned Action selector is the only authority for either.
         */
        setupRemediation: {
            required: false,
            input: { kind: 'contributorDefined' },
            resultSchema: ConversationProviderSetupRemediationResultV1Schema,
            action: { surfaces: ['plugin', 'ui'], dangerLevel: 'writesRemote' },
        },
        connectionTest: {
            required: true,
            input: { kind: 'protocolDefined', schema: ConversationConnectionTestInputV1Schema },
            resultSchema: ConversationConnectionTestResultV1Schema,
            action: { surfaces: ['plugin', 'ui'], dangerLevel: 'safe' },
        },
        endpointResolve: {
            required: false,
            input: { kind: 'protocolDefined', schema: ConversationEndpointResolveInputV1Schema },
            resultSchema: ConversationEndpointResolveResultV1Schema,
            action: { surfaces: ['plugin', 'ui'], dangerLevel: 'safe' },
        },
        principalResolve: {
            required: false,
            input: { kind: 'protocolDefined', schema: ConversationPrincipalResolveInputV1Schema },
            resultSchema: ConversationPrincipalResolveResultV1Schema,
            action: { surfaces: ['plugin', 'ui'], dangerLevel: 'safe' },
        },
        observationsPoll: {
            required: false,
            input: { kind: 'protocolDefined', schema: ConversationPollInputV1Schema },
            resultSchema: ConversationPollResultV1Schema,
            action: { surfaces: ['plugin'], dangerLevel: 'safe' },
        },
        attachmentFetch: {
            required: false,
            input: { kind: 'protocolDefined', schema: ConversationAttachmentFetchInputV1Schema },
            resultSchema: ConversationAttachmentFetchResultV1Schema,
            action: { surfaces: ['plugin'], dangerLevel: 'safe' },
        },
        /**
         * Optional stateless bridge from one durable Channels Event obligation
         * to the provider's own current Automation definitions. The Channels
         * core remains the only retry, currentness, and checkpoint owner.
         */
        automationEventAdmit: {
            required: false,
            input: { kind: 'protocolDefined', schema: ConversationProviderAutomationEventAdmitInputV1Schema },
            resultSchema: ConversationProviderAutomationEventAdmitResultV1Schema,
            action: { surfaces: ['plugin'], dangerLevel: 'writesRemote' },
        },
        messageDeliver: {
            required: true,
            input: { kind: 'protocolDefined', schema: ConversationDeliveryInputV1Schema },
            resultSchema: ConversationDeliveryResultV1Schema,
            action: { surfaces: ['plugin'], dangerLevel: 'writesRemote' },
        },
        deliveryReconcile: {
            required: false,
            input: { kind: 'protocolDefined', schema: ConversationDeliveryReconcileInputV1Schema },
            resultSchema: ConversationDeliveryResultV1Schema,
            action: { surfaces: ['plugin'], dangerLevel: 'safe' },
        },
        // Retained declaration grammar only; Channels no longer invokes this role.
        connectionStop: {
            required: false,
            input: { kind: 'protocolDefined', schema: ConversationProviderConnectionStopInputV1Schema },
            resultSchema: ConversationProviderConnectionStopResultV1Schema,
            action: { surfaces: ['plugin'], dangerLevel: 'writesRemote' },
        },
    },
});

/** The target-owned `providers` point accepts one V1 contribution per provider plugin. */
export const ConversationProvidersContributionPointV1 = defineContributionPoint(
    [ConversationProvidersContributionProtocolV1],
    { maxContributionsPerContributor: 1 },
);

export type ConversationProviderContributionV1 = typeof ConversationProvidersContributionProtocolV1 extends ContributionProtocol<
    infer Operations, infer Surfaces, infer Descriptor, infer _Id, infer _Version
> ? ContributionAdmittedEntry<Operations, Surfaces, Descriptor, typeof CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_ID_V1> : never;

/** Portable equality-qualified discovery; operation authority remains host-issued. */
export const CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_REF_V1: TargetedContributionPointRef<ConversationProviderContributionV1> = Object.freeze({
    targetPluginId: CONVERSATION_CORE_PLUGIN_ID_V1,
    id: CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_ID_V1,
    protocol: Object.freeze({ id: ConversationProvidersContributionProtocolV1.id, version: ConversationProvidersContributionProtocolV1.version }),
});
