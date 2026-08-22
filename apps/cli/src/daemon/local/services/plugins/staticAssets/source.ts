import { join, posix } from 'node:path';

import {
    PluginHostedWebSecurityPolicyV1Schema,
    type PluginUiArtifactsManifestEntryV1,
} from '@happier-dev/protocol/plugins/ui';

import { GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH } from '@/plugins/install/ui/generatedArtifacts';
import type {
    ResolvedContributionRegistry,
    ResolvedUiRendererV2Contribution,
} from '@/plugins/projection/registry/types';

import type { HostedWebStaticAssetLifecycleContribution } from './lifecycle';

export const HOSTED_WEB_UI_ARTIFACTS_ROOT_RELATIVE_PATH = GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH;

export type HostedWebStaticAssetLifecycleSourceDiagnosticCode =
    | 'hosted_web_static_artifact_missing'
    | 'hosted_web_static_artifact_platform_mismatch'
    | 'hosted_web_static_artifact_asset_root_invalid'
    | 'hosted_web_static_asset_plugin_root_unavailable';

export type HostedWebStaticAssetLifecycleSourceDiagnostic = Readonly<{
    severity: 'warning' | 'error';
    code: HostedWebStaticAssetLifecycleSourceDiagnosticCode;
    pluginId: string;
    contributionId: string;
    diagnostics: readonly string[];
}>;

export type HostedWebStaticAssetLifecycleSourceResult = Readonly<{
    contributions: readonly HostedWebStaticAssetLifecycleContribution[];
    diagnostics: readonly HostedWebStaticAssetLifecycleSourceDiagnostic[];
}>;

function diagnostic(input: Readonly<{
    code: HostedWebStaticAssetLifecycleSourceDiagnosticCode;
    pluginId: string;
    contributionId: string;
    diagnostics?: readonly string[];
}>): HostedWebStaticAssetLifecycleSourceDiagnostic {
    return Object.freeze({
        severity: 'error' as const,
        code: input.code,
        pluginId: input.pluginId,
        contributionId: input.contributionId,
        diagnostics: Object.freeze([...(input.diagnostics ?? [input.code])]),
    });
}

function resolveGeneratedRendererTitle(input: Readonly<{
    renderer: ResolvedUiRendererV2Contribution;
    views: NonNullable<ResolvedContributionRegistry['uiViewsV2']>;
}>): string {
    const view = input.views.find((candidate) => (
        candidate.pluginId === input.renderer.pluginId
        && candidate.definition.renderer === input.renderer.definition.id
    ));
    const title = view?.definition.title;
    if (typeof title === 'string') return title;
    if (title && typeof title === 'object' && 'fallback' in title && typeof title.fallback === 'string') {
        return title.fallback;
    }
    return view?.definition.id ?? input.renderer.definition.id;
}

function resolveGeneratedHostedWebEntry(
    renderer: ResolvedUiRendererV2Contribution,
): Readonly<{
    entry: PluginUiArtifactsManifestEntryV1;
    assetRootId: string;
}> | null {
    const definition = renderer.definition;
    if (definition.kind !== 'hostedWeb' || definition.source.kind !== 'artifact') {
        return null;
    }
    const artifactId = definition.source.artifact;
    const entry = renderer.generatedUiArtifactsManifest?.entries.find((candidate) => (
        candidate.contributionId === artifactId
        && candidate.tier === 'hostedWeb'
        && candidate.platform === 'web'
    ));
    if (!entry) return null;
    const assetRootId = posix.dirname(entry.entry);
    if (
        assetRootId === '.'
        || !entry.files.some((file) => file.relativePath === entry.entry)
        || !entry.files.every((file) => (
            file.relativePath === assetRootId || file.relativePath.startsWith(`${assetRootId}/`)
        ))
    ) {
        return null;
    }
    return Object.freeze({ entry, assetRootId });
}

export async function resolveHostedWebStaticAssetLifecycleSource(input: Readonly<{
    registry: Pick<ResolvedContributionRegistry, 'uiViewsV2' | 'uiRenderersV2'>;
    sessionId: string;
    machineId: string;
}>): Promise<HostedWebStaticAssetLifecycleSourceResult> {
    const diagnostics: HostedWebStaticAssetLifecycleSourceDiagnostic[] = [];
    const contributions: HostedWebStaticAssetLifecycleContribution[] = [];

    for (const renderer of input.registry.uiRenderersV2 ?? []) {
        const definition = renderer.definition;
        if (
            definition.kind !== 'hostedWeb'
            || definition.source.kind !== 'artifact'
        ) {
            continue;
        }
        const artifactId = definition.source.artifact;
        const pluginId = renderer.pluginId;
        const contributionId = definition.id;
        const manifest = renderer.generatedUiArtifactsManifest;
        if (!renderer.pluginRootPath) {
            diagnostics.push(diagnostic({
                code: 'hosted_web_static_asset_plugin_root_unavailable',
                pluginId,
                contributionId,
            }));
            continue;
        }
        const matchingEntries = manifest?.entries.filter((entry) => (
            entry.contributionId === artifactId
            && entry.tier === 'hostedWeb'
        )) ?? [];
        if (matchingEntries.length === 0) {
            diagnostics.push(diagnostic({
                code: 'hosted_web_static_artifact_missing',
                pluginId,
                contributionId,
            }));
            continue;
        }
        if (!matchingEntries.some((entry) => entry.platform === 'web')) {
            diagnostics.push(diagnostic({
                code: 'hosted_web_static_artifact_platform_mismatch',
                pluginId,
                contributionId,
            }));
            continue;
        }
        const generated = resolveGeneratedHostedWebEntry(renderer);
        if (!generated) {
            diagnostics.push(diagnostic({
                code: 'hosted_web_static_artifact_asset_root_invalid',
                pluginId,
                contributionId,
            }));
            continue;
        }
        contributions.push(Object.freeze({
            pluginId,
            contributionId,
            manifestContributionId: artifactId,
            sessionId: input.sessionId,
            machineId: input.machineId,
            title: resolveGeneratedRendererTitle({
                renderer,
                views: input.registry.uiViewsV2 ?? [],
            }),
            installedRoot: join(renderer.pluginRootPath, HOSTED_WEB_UI_ARTIFACTS_ROOT_RELATIVE_PATH),
            runtimeMode: Object.freeze({
                kind: 'installedStaticAssets' as const,
                artifactId,
                assetRootId: generated.assetRootId,
            }),
            artifactManifest: manifest,
            routeMode: 'pathFallback' as const,
            security: PluginHostedWebSecurityPolicyV1Schema.parse({}),
            sourceMaps: Object.freeze({ enabled: false as const }),
        }));
    }


    return Object.freeze({
        contributions: Object.freeze(contributions),
        diagnostics: Object.freeze(diagnostics),
    });
}
