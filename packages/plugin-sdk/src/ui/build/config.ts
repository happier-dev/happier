/** @moduleRealm build */
export type PluginUiArtifactPlatform = 'web' | 'ios' | 'android' | 'desktop';

export const BUILD_CONFIG_BASENAMES = Object.freeze([
    'pluginUiBuild.mjs',
    'pluginUiBuild.js',
    'pluginUiBuild.ts',
    'happier-plugin-ui.config.mjs',
    'happier-plugin-ui.config.js',
    'happier-plugin-ui.config.ts',
] as const);

/** The managed bundler work root used when a build config omits `outDir`. */
export const DEFAULT_PLUGIN_UI_BUILD_OUT_DIR = 'dist/ui';

/**
 * The single owner of the plugin UI surface emission layout, for every tier.
 *
 * `happier-plugin-build-ui` re-roots each built surface here — hosted web to
 * `<outDir>/hosted-web/<rendererId>`, the react-native web/desktop bundle to
 * `<outDir>/react-native-web/<rendererId>` and each native platform to
 * `<outDir>/react-native/<rendererId>/<platform>` — and requires the declared
 * entry inside it. The managed builder resolves every Vite and Re.Pack config
 * through this projection, so no author-owned config can drift from the
 * builder's artifact layout.
 */
export function resolvePluginUiSurfaceOutDir(input: Readonly<{
    kind: 'hostedWeb';
    rendererId: string;
    outDir?: string;
}> | Readonly<{
    kind: 'reactNative';
    rendererId: string;
    // The platform vocabulary is restated the way `defineBuildConfig` restates
    // it, so the public build surface publishes no additional named type.
    platform: 'web' | 'ios' | 'android' | 'desktop';
    outDir?: string;
}>): string {
    const outDir = input.outDir?.trim() || DEFAULT_PLUGIN_UI_BUILD_OUT_DIR;
    if (input.kind === 'hostedWeb') return `${outDir}/hosted-web/${input.rendererId}`;
    // The web and desktop platforms share one react-native-web bundle; only the
    // native platforms are emitted per platform.
    if (input.platform === 'web' || input.platform === 'desktop') {
        return `${outDir}/react-native-web/${input.rendererId}`;
    }
    return `${outDir}/react-native/${input.rendererId}/${input.platform}`;
}

/**
 * The sole author-facing plugin UI build contract.
 *
 * `outDir` is the host-managed bundler work/emission root. It is deliberately
 * not the install artifact root: `happier-plugin-build-ui` verifies and stages
 * the completed graph under the canonical `dist/happier-plugin-ui` owner.
 */
export type PluginUiBuildTarget =
    | Readonly<{
        rendererId: string;
        entry: string;
        /**
         * Project-relative advanced Vite extension for this target.
         *
         * Standard targets need no author config: the managed builder derives
         * one operation-local Vite config from `rendererId` and `entry`. This
         * bounded escape hatch contributes author-specific pre-resolution Vite
         * options, but the builder retains the generated HTML entry, root, and
         * output. `configResolved` hooks are not supported because Vite has
         * already derived managed build state by that phase.
         * Hosted web can be plain static assets, so it does not imply a
         * `@happier-dev/plugin-ui` package instance. One extension may serve
         * multiple generated Vite surfaces.
         */
        bundlerConfig?: string;
        /** Hosted web emits one portable graph; runtime admission owns its cells. */
        kind: 'hostedWeb';
    }>
    | Readonly<{
        rendererId: string;
        entry: string;
        /**
         * Project-relative advanced pre-resolution Vite extension for the
         * web/desktop tier. The managed builder still owns the root, entry,
         * output, host-runtime externals, and physical
         * `@happier-dev/plugin-ui` package check. `configResolved` hooks are
         * not supported because Vite has already derived managed build state by
         * that phase.
         */
        bundlerConfig?: string;
        kind: 'reactNative';
        platforms: readonly PluginUiArtifactPlatform[];
        /** Exact Module Federation identity required when ios/android is claimed. */
        module?: Readonly<{
            containerName: string;
            modulePath: string;
            exportName: string;
        }>;
        /** One candidate-only export shared by native and RN-web artifact builds. */
        collectionMigrations?: Readonly<{
            exportName: string;
        }>;
    }>;

export type PluginUiBuildConfig = Readonly<{
    projectRoot?: string;
    outDir?: string;
    targets: readonly PluginUiBuildTarget[];
}>;

/**
 * The sole author-facing UI build configuration contract. Hosted web and
 * React Native deliberately use distinct target shapes: a hosted target
 * describes one portable web graph, while React Native declares its emitted
 * build targets explicitly.
 */
export function defineBuildConfig<const TConfig extends PluginUiBuildConfig>(
    config: TConfig
        & Readonly<Record<Exclude<keyof TConfig, 'projectRoot' | 'outDir' | 'targets'>, never>>
        & Readonly<{
            targets: TConfig['targets'] extends readonly (infer TTarget)[]
                ? readonly (
                    TTarget extends Readonly<{ kind: 'hostedWeb' }>
                        ? TTarget & Readonly<Record<
                            Exclude<keyof TTarget, 'rendererId' | 'entry' | 'kind' | 'bundlerConfig'>,
                            never
                        >>
                        : TTarget extends Readonly<{ kind: 'reactNative' }>
                            ? TTarget
                                & Readonly<Record<
                                    Exclude<keyof TTarget, 'rendererId' | 'entry' | 'kind' | 'platforms' | 'bundlerConfig' | 'module' | 'collectionMigrations'>,
                                    never
                                >>
                                & (TTarget extends Readonly<{ module?: infer TModule }>
                                    ? Readonly<{
                                        module?: TModule extends object
                                            ? TModule & Readonly<Record<
                                                Exclude<keyof TModule, 'containerName' | 'modulePath' | 'exportName'>,
                                                never
                                            >>
                                            : TModule;
                                    }>
                                    : unknown)
                                & (TTarget extends Readonly<{ collectionMigrations?: infer TCollectionMigrations }>
                                    ? Readonly<{
                                        collectionMigrations?: TCollectionMigrations extends object
                                            ? TCollectionMigrations & Readonly<Record<
                                                Exclude<keyof TCollectionMigrations, 'exportName'>,
                                                never
                                            >>
                                            : TCollectionMigrations;
                                    }>
                                    : unknown)
                            : never
                )[]
                : never;
        }>,
): TConfig {
    return config;
}
