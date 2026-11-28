import { normalizeInputHintsText as normalizeActionInputHintsText, type InputHints as ActionInputHints } from '@happier-dev/protocol/inputs/inputFields';
import type { PluginLocalizedStringV2 } from '@happier-dev/protocol/plugins/contributions/public-types';
import type { PluginProjectedActionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';

import { resolvePluginLocalizedText, type PluginLocalizedTextResolver } from './i18n';
import { createPluginUiProjectedActionResolver, type PluginUiProjectionModel } from './projection';

/**
 * The wire-carried presentation subset of an admitted Action. Keeping this
 * separate from the executable definition lets host presentation resolve the
 * author-declared translation descriptors without changing Action ownership.
 */
export type PluginProjectedActionPresentation = Pick<
    PluginProjectedActionV2,
    'title' | 'description' | 'inputHints'
>;

export type PluginProjectedActionReviewPresentation = Pick<
    PluginProjectedActionV2,
    'title' | 'dangerLevel' | 'inputHints' | 'confirmation' | 'confirmVerb' | 'irreversible'
>;

export type ResolvedPluginProjectedActionPresentation = Readonly<{
    title: string;
    description: string | null;
    inputHints: ActionInputHints | null;
}>;

/** Resolves presentation for an exact Action already known to the caller. */
export function createPluginProjectedActionReviewResolver(projection: PluginUiProjectionModel | null) {
    const resolveAction = createPluginUiProjectedActionResolver(projection?.actionsById);
    return ({ pluginId, localId }: PluginContributionIdentityV1): PluginProjectedActionReviewPresentation | undefined => {
        const action = resolveAction({ pluginId, localId });
        if (action) return action;
        const presentations = projection?.installedPackagesById[pluginId]?.actionPresentationsById;
        return presentations && Object.hasOwn(presentations, localId) ? presentations[localId] : undefined;
    };
}

export function createPluginProjectedActionTitleResolver(projection: PluginUiProjectionModel | null) {
    const resolveAction = createPluginProjectedActionReviewResolver(projection);
    return (identity: PluginContributionIdentityV1) => resolveAction(identity)?.title;
}

/** The immediate and retained Action confirmations share the declaration's decision copy and tone. */
export function resolvePluginActionConfirmationDecision(
    action: PluginProjectedActionReviewPresentation,
    confirmation: Pick<NonNullable<PluginProjectedActionV2['confirmation']>, 'confirmLabel'> | undefined,
    resolveText: (value: PluginLocalizedStringV2) => string,
) {
    return {
        confirmLabel: resolveText(action.confirmVerb ?? confirmation?.confirmLabel ?? action.title),
        destructive: action.dangerLevel === 'destructive' || action.irreversible === true,
    };
}

function resolveActionText(params: Readonly<{
    value: PluginLocalizedStringV2;
    pluginId: string;
    projection: PluginUiProjectionModel | null | undefined;
    locale?: string | null;
    localize?: PluginLocalizedTextResolver;
}>): string {
    const { value } = params;
    if (params.localize) return params.localize(params.pluginId, value);
    if (typeof value === 'string') return value.trim();
    return resolvePluginLocalizedText({
        projection: params.projection,
        pluginId: params.pluginId,
        locale: params.locale,
        value,
    });
}

/**
 * The sole Action-presentation resolver for host UI and Voice. It delegates
 * translation lookup to the projected-plugin i18n owner and nested form shape
 * normalization to Protocol, so neither consumer can invent its own fallback
 * or input-hint path.
 */
export function resolvePluginProjectedActionPresentation(params: Readonly<{
    pluginId: string;
    presentation: PluginProjectedActionPresentation;
    projection: PluginUiProjectionModel | null | undefined;
    locale?: string | null;
    localize?: PluginLocalizedTextResolver;
}>): ResolvedPluginProjectedActionPresentation {
    const resolveText = (value: PluginLocalizedStringV2): string => resolveActionText({
        value,
        pluginId: params.pluginId,
        projection: params.projection,
        locale: params.locale,
        localize: params.localize,
    });
    const description = params.presentation.description;
    const inputHints = params.presentation.inputHints;

    return Object.freeze({
        title: resolveText(params.presentation.title),
        description: description === undefined || description === null
            ? null
            : resolveText(description),
        inputHints: inputHints ? normalizeActionInputHintsText(inputHints, resolveText) : null,
    });
}
