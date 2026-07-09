import {
    PluginHostedWebContributionV1Schema,
    PluginReactNativeBundleContributionV1Schema,
    PluginSurfacePlacementDescriptorV1Schema,
    type PluginHostedWebContributionV1,
    type PluginReactNativeBundleContributionV1,
    type PluginSurfacePlacementDescriptorV1,
} from '@happier-dev/protocol/plugins/contributions/ui';

/**
 * REG-3 — the single canonical author entry for plugin surface contributions.
 *
 * `defineSurfaceContribution` is the ONE helper authors call to declare a surface
 * contribution, replacing the historically-scattered per-family definers
 * (`defineHostedWebUi`/`defineHostedWeb`, `defineReactNativeBundleUi`/
 * `defineReactNativeBundle`, and the folded-away `defineSessionSurface`). The
 * runtime MODE selects which contribution shape is authored:
 *
 *   - `surfacePlacement`   → host-rendered (and hostedWeb/RN-renderer) surface
 *                            placement descriptor (the former "session surface"
 *                            + every other mounted placement)
 *   - `hostedWeb`          → a hosted-web service contribution (embed an
 *                            existing/external web UI; works on native via
 *                            WebView)
 *   - `reactNative`        → a React Native bundle contribution — the DEFAULT
 *                            authoring path; also renders on web via a
 *                            react-native-web federation build of the SAME
 *                            source (`reactNativeWebBuild.ts`)
 *
 * Each branch validates against the canonical protocol schema (reject-at-author),
 * mirroring the registry's reject-at-projection chokepoint so an illegal
 * contribution is unrepresentable at BOTH the author and projection boundaries.
 *
 * RN-WEB-LOADER / LEDGER DEC-6 retirement note: a fourth `mode: 'embeddedWeb'`
 * arm briefly existed here (G7 naming cleanup, closing the historical
 * "embeddedWeb authored under mode:'hostedWeb'" mismatch). DEC-6 then decided
 * `embeddedWeb` is RETIRED from the public authoring story: its authoring
 * surface (`import {View,Text} from 'react-native-web'` directly, in-process,
 * no native path) is a strict subset of what `reactNative` mode now offers
 * (same in-process web rendering via react-native-web, PLUS native support)
 * for identical runtime cost, and it had zero real consumers (verified by
 * RN-ANALYSIS.md and re-confirmed at retirement time). Only two authoring
 * modes remain — see the module doc above.
 */

export type DefineSurfaceContributionInputV1 =
    | Readonly<{
        mode: 'surfacePlacement';
        contribution: PluginSurfacePlacementDescriptorV1;
    }>
    | Readonly<{
        mode: 'hostedWeb';
        contribution: PluginHostedWebContributionV1;
    }>
    | Readonly<{
        mode: 'reactNative';
        contribution: PluginReactNativeBundleContributionV1;
    }>;

export type DefineSurfaceContributionResultV1<TInput extends DefineSurfaceContributionInputV1> =
    TInput extends { mode: 'surfacePlacement' }
        ? PluginSurfacePlacementDescriptorV1
        : TInput extends { mode: 'hostedWeb' }
            ? PluginHostedWebContributionV1
            : PluginReactNativeBundleContributionV1;

export function defineSurfaceContribution<const TInput extends DefineSurfaceContributionInputV1>(
    input: TInput,
): DefineSurfaceContributionResultV1<TInput> {
    switch (input.mode) {
        case 'surfacePlacement':
            return PluginSurfacePlacementDescriptorV1Schema.parse(
                input.contribution,
            ) as DefineSurfaceContributionResultV1<TInput>;
        case 'hostedWeb':
            return PluginHostedWebContributionV1Schema.parse(
                input.contribution,
            ) as DefineSurfaceContributionResultV1<TInput>;
        case 'reactNative':
            return PluginReactNativeBundleContributionV1Schema.parse(
                input.contribution,
            ) as DefineSurfaceContributionResultV1<TInput>;
        default:
            // Unauthored (non-TS or stale-typed) callers might still pass the
            // retired `mode: 'embeddedWeb'` at runtime — fail closed with a
            // clear message rather than silently falling through.
            throw new Error(
                `defineSurfaceContribution: mode "${String((input as { mode?: unknown }).mode)}" is not `
                    + 'supported. embeddedWeb is retired (LEDGER DEC-6) — use mode: \'reactNative\' '
                    + '(renders on web too) or mode: \'hostedWeb\' (embed an existing web UI).',
            );
    }
}
