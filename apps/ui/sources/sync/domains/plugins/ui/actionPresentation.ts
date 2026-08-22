import {
    normalizeActionInputHintsText,
    type ActionInputHints,
    type PluginLocalizedStringV2,
    type PluginProjectedActionV2,
} from '@happier-dev/protocol';

import { resolvePluginUiText } from './i18n';
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
}>): string {
    const { value } = params;
    return resolvePluginUiText({
        projection: params.projection,
        pluginId: params.pluginId,
        key: typeof value === 'string' ? null : value.key,
        locale: params.locale,
        fallback: typeof value === 'string' ? value : value.fallback,
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
}>): ResolvedPluginProjectedActionPresentation {
    const resolveText = (value: PluginLocalizedStringV2): string => resolveActionText({
        value,
        pluginId: params.pluginId,
        projection: params.projection,
        locale: params.locale,
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
