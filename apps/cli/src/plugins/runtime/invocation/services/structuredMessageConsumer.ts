import {
    createPluginContributionIdentity,
    type PluginContributionIdentityV1,
    type PluginResourceKindV2,
    type PluginStructuredMessageDescriptorV1,
} from '@happier-dev/protocol';
import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';

import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import {
    evaluateContributionAvailability,
    type ContributionPolicyFacts,
} from '@/plugins/runtime/policy/evaluate';

import {
    createStablePluginDeclarativeModel,
    createStablePluginStructuredMessageModel,
    type StablePluginDeclarativeModel,
    type StablePluginStructuredMessageModel,
} from './declarativeModel';
import { createStablePluginSettingsModel } from './settings';

export type StablePluginStructuredMessageResolution = Readonly<{
    model: StablePluginStructuredMessageModel;
    renderer: StablePluginDeclarativeModel;
    resources: readonly Readonly<{
        reference: StablePluginStructuredMessageModel['resources'][number];
        kind: PluginResourceKindV2;
        contentType: string;
        digest: string;
        bytes: Uint8Array;
    }>[];
}>;

export type StablePluginStructuredMessageConsumerModel = Readonly<{
    model: StablePluginStructuredMessageModel;
    renderer: StablePluginDeclarativeModel;
}>;

function consumerError(code: string, message: string): PluginError {
    return new PluginError({ code, message });
}

function contributionIdentities(
    values: readonly Readonly<{ pluginId?: string; definition: Readonly<{ id: string }> }>[],
): readonly PluginContributionIdentityV1[] {
    return Object.freeze(values.flatMap((value) => {
        const pluginId = value.pluginId?.trim();
        return pluginId
            ? [createPluginContributionIdentity({ pluginId, localId: value.definition.id })]
            : [];
    }));
}

/**
 * Turns an untrusted transcript value into the sole stable host-rendered model.
 *
 * This adapter deliberately delegates payload/schema/reference normalization to
 * `createStablePluginStructuredMessageModel` and policy decisions to WS2. It
 * does not read resources or execute actions; those remain owned by SVC11 and
 * the canonical action executor respectively.
 */
export function resolveStablePluginStructuredMessage(params: Readonly<{
    registry: ResolvedContributionRegistry;
    expectedGeneration: string;
    currentGeneration?: string;
    kind: string;
    payload: JsonValue;
    resourceRefs?: NonNullable<PluginStructuredMessageDescriptorV1['actions']>;
    facts: ContributionPolicyFacts;
}>): StablePluginStructuredMessageModel {
    const currentGeneration = params.currentGeneration ?? params.registry.generationId;
    if (!currentGeneration || currentGeneration !== params.expectedGeneration) {
        throw consumerError(
            'plugin_structured_message_generation_retired',
            'Structured-message projection generation is no longer current',
        );
    }

    const matches = (params.registry.structuredMessages ?? []).filter((candidate) => (
        candidate.definition.kind === params.kind && candidate.pluginId?.trim()
    ));
    if (matches.length === 0) {
        throw consumerError('plugin_structured_message_unknown_kind', 'Structured-message kind is not declared');
    }
    if (matches.length !== 1) {
        throw consumerError('plugin_structured_message_kind_ambiguous', 'Structured-message kind is ambiguous');
    }

    const contribution = matches[0]!;
    const pluginId = contribution.pluginId!.trim();
    const availability = evaluateContributionAvailability({
        availability: contribution.definition.availability,
        facts: params.facts,
    });
    const actionIdentities = contributionIdentities(params.registry.actions);
    const enabledActions = Object.fromEntries(actionIdentities.map((identity) => [
        `${identity.pluginId}/${identity.localId}`,
        availability.outcome === 'visible',
    ]));

    return createStablePluginStructuredMessageModel({
        pluginId,
        generation: currentGeneration,
        descriptor: contribution.definition,
        value: {
            kind: params.kind,
            payload: params.payload,
            ...(params.resourceRefs ? { resources: params.resourceRefs } : {}),
        },
        actions: actionIdentities,
        resources: contributionIdentities(params.registry.resources),
        renderers: contributionIdentities(params.registry.uiRenderersV2 ?? []),
        availability: {
            visible: availability.outcome === 'visible',
            enabledActions: Object.freeze(enabledActions),
        },
    });
}

export function resolveStablePluginStructuredMessageConsumer(params: Parameters<
    typeof resolveStablePluginStructuredMessage
>[0]): StablePluginStructuredMessageConsumerModel {
    const model = resolveStablePluginStructuredMessage(params);
    const rendererContribution = (params.registry.uiRenderersV2 ?? []).find((candidate) => (
        candidate.identity.pluginId === model.renderer.identity.pluginId
        && candidate.identity.localId === model.renderer.identity.localId
    ));
    if (!rendererContribution) {
        throw consumerError('plugin_structured_message_renderer_missing', 'Structured-message renderer is not declared');
    }
    const settings = (params.registry.settings ?? [])
        .filter((candidate) => candidate.pluginId === rendererContribution.pluginId)
        .map((candidate) => createStablePluginSettingsModel({
            pluginId: rendererContribution.pluginId,
            contribution: candidate.definition,
        }));
    const renderer = createStablePluginDeclarativeModel({
        pluginId: rendererContribution.pluginId,
        generation: model.identity.generation,
        renderer: rendererContribution.definition,
        settings,
        actions: model.actions.map((action) => action.identity),
        availability: {
            visible: model.visible,
            enabledActions: Object.freeze(Object.fromEntries(model.actions.map((action) => [
                action.qualifiedId,
                action.enabled,
            ]))),
        },
    });
    return Object.freeze({ model, renderer });
}
