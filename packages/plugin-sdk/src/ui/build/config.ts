export type PluginUiArtifactPlatform = 'web' | 'ios' | 'android' | 'desktop';

export const PLUGIN_UI_BUILD_CONFIG_BASENAMES = Object.freeze([
    'pluginUiBuild.mjs',
    'pluginUiBuild.js',
    'pluginUiBuild.ts',
    'happier-plugin-ui.config.mjs',
    'happier-plugin-ui.config.js',
    'happier-plugin-ui.config.ts',
] as const);

export type PluginUiBuildTarget = Readonly<{
    rendererId: string;
    entry: string;
    kind: 'reactNative' | 'hostedWeb';
    platforms: readonly PluginUiArtifactPlatform[];
    /** Exact Module Federation identity emitted by the author-owned Re.Pack config. Required when ios/android is claimed. */
    module?: Readonly<{
        containerName: string;
        modulePath: string;
        exportName: string;
    }>;
}>;

/**
 * The sole author-facing plugin UI build contract.
 *
 * `outDir` is the host-managed bundler work/emission root. It is deliberately
 * not the install artifact root: `happier-plugin-build-ui` verifies and stages
 * the completed graph under the canonical `dist/happier-plugin-ui` owner.
 */
export type PluginUiBuildConfig = Readonly<{
    projectRoot?: string;
    outDir?: string;
    targets: readonly PluginUiBuildTarget[];
}>;
type DeepExact<TValue, TShape> = TShape extends readonly (infer TShapeItem)[]
    ? TValue extends readonly (infer TValueItem)[] ? TValue & readonly DeepExact<TValueItem, TShapeItem>[] : never
    : TShape extends object ? TValue extends object ? TValue & { [TKey in keyof TValue]: TKey extends keyof TShape ? DeepExact<TValue[TKey], TShape[TKey]> : never } : never
    : TValue extends TShape ? TValue : never;
export function definePluginUiBuildConfig<const TConfig extends PluginUiBuildConfig>(
    config: DeepExact<TConfig, PluginUiBuildConfig>,
): TConfig {
    return config;
}
