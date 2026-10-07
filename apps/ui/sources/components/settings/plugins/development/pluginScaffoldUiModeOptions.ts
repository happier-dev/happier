import {
    DEFAULT_PLUGIN_SCAFFOLD_UI_MODE,
    PluginScaffoldUiModeSchema,
    type PluginScaffoldUiMode,
} from '@happier-dev/protocol/actions/actionSpecs';

import { t } from '@/text';

/**
 * The Create form's surface choices, derived from the one Protocol scaffold
 * vocabulary rather than re-enumerated here.
 *
 * `satisfies` is load-bearing: a new arm in `PluginScaffoldUiModeSchema` fails
 * this map to compile until it has a label, which is what keeps the app from
 * quietly offering fewer shapes than `happier plugins create` accepts.
 */
const LABEL_KEY_BY_MODE = {
    declarative: 'settingsPlugins.developmentCreateSurfaceDeclarative',
    hostedWeb: 'settingsPlugins.developmentCreateSurfaceHostedWeb',
    reactNative: 'settingsPlugins.developmentCreateSurfaceReactNative',
} as const satisfies Readonly<Record<PluginScaffoldUiMode, string>>;

export { DEFAULT_PLUGIN_SCAFFOLD_UI_MODE };

export function createPluginScaffoldUiModeOptions(): readonly Readonly<{
    value: PluginScaffoldUiMode;
    label: string;
}>[] {
    return PluginScaffoldUiModeSchema.options.map((mode) => Object.freeze({
        value: mode,
        label: t(LABEL_KEY_BY_MODE[mode]),
    }));
}

/** Narrows a form answer through the canonical vocabulary owner. */
export function readPluginScaffoldUiMode(value: unknown): PluginScaffoldUiMode | null {
    const parsed = PluginScaffoldUiModeSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}
