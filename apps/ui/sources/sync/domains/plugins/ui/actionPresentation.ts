import { normalizeInputHintsText as normalizeActionInputHintsText, type InputHints as ActionInputHints } from '@happier-dev/protocol/inputs/inputFields';
import type { PluginLocalizedStringV2 } from '@happier-dev/protocol/plugins/contributions/public-types';
import type { PluginProjectedActionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { resolvePluginLocalizedText, type PluginLocalizedTextResolver } from './i18n';
import type { PluginUiProjectionModel } from './projection';

/**
 * The wire-carried presentation subset of an admitted Action. Keeping this
 * separate from the executable definition lets host presentation resolve the
 * author-declared translation descriptors without changing Action ownership.
 */
export type PluginProjectedActionPresentation = Pick<
    PluginProjectedActionV2,
    'title' | 'description' | 'inputHints'
>;

export type ResolvedPluginProjectedActionPresentation = Readonly<{
    title: string;
    description: string | null;
    inputHints: ActionInputHints | null;
}>;

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
