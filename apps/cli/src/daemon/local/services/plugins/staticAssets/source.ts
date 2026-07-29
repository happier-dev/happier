import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';

import type { PluginUiArtifactContributionV1 } from '@happier-dev/protocol';
import {
    PLUGIN_UI_HOST_API_VERSION_V1,
    PluginHostedWebSecurityPolicyV1Schema,
    resolvePluginHostedWebSourceMapPolicyV1,
    type PluginUiArtifactsManifestEntryV1,
} from '@happier-dev/protocol/plugins/ui';

import { GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH } from '@/plugins/install/ui/generatedArtifacts';
import type {
    ResolvedContributionRegistry,
    ResolvedHostedWebContribution,
    ResolvedUiArtifactContribution,
    ResolvedUiRendererV2Contribution,
} from '@/plugins/projection/registry/types';

import type { HostedWebStaticAssetLifecycleContribution } from './lifecycle';

export const HOSTED_WEB_UI_ARTIFACTS_ROOT_RELATIVE_PATH = GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH;
const HOSTED_WEB_UI_ARTIFACTS_MANIFEST_FILE = 'ui-artifacts.json';

export type HostedWebStaticAssetLifecycleSourceDiagnosticCode =
    | 'hosted_web_static_artifact_missing'
    | 'hosted_web_static_artifact_integrity_missing'
    | 'hosted_web_static_artifact_platform_mismatch'
    | 'hosted_web_static_artifact_host_api_mismatch'
    | 'hosted_web_static_artifact_asset_root_invalid'
    | 'hosted_web_static_asset_plugin_root_unavailable'
    | 'hosted_web_ui_artifacts_manifest_read_failed';

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

function readOptionalString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function contributionPluginRoot(contribution: ResolvedHostedWebContribution): string | null {
    return readOptionalString(contribution.pluginRootPath);
}

function artifactPluginRoot(artifact: ResolvedUiArtifactContribution): string | null {
    return readOptionalString(artifact.pluginRootPath);
}

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

function findHostedWebArtifact(input: Readonly<{
    contribution: ResolvedHostedWebContribution;
    artifacts: readonly ResolvedUiArtifactContribution[];
}>): ResolvedUiArtifactContribution | null {
    return input.artifacts.find((artifact) => (
        artifact.pluginId === input.contribution.pluginId
        && artifact.definition.contributionId === input.contribution.definition.id
        && artifact.definition.contributionFamily === 'hostedWeb'
        && artifact.definition.artifactKind === 'hostedWebAsset'
        && artifact.definition.platform === 'web'
    )) ?? null;
}

function toExecutableArtifactManifest(input: Readonly<{
    pluginId: string;
    artifact: PluginUiArtifactContributionV1;
}>): Readonly<PluginUiArtifactContributionV1 & { pluginId: string }> {
    return Object.freeze({
        ...input.artifact,
        pluginId: input.pluginId,
    });
}

function resolveContributionTitle(contribution: ResolvedHostedWebContribution): string {
    return contribution.definition.display.developerFallback
        ?? contribution.definition.display.labelKey
        ?? contribution.definition.display.titleKey;
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

async function readUiArtifactsManifest(input: Readonly<{
    installedRoot: string;
    readTextFile: (path: string) => Promise<string>;
}>): Promise<Readonly<{ ok: true; manifest: unknown }> | Readonly<{ ok: false }>> {
    try {
        const raw = await input.readTextFile(join(input.installedRoot, HOSTED_WEB_UI_ARTIFACTS_MANIFEST_FILE));
        return Object.freeze({ ok: true as const, manifest: JSON.parse(raw) });
    } catch {
        return Object.freeze({ ok: false as const });
    }
}

export async function resolveHostedWebStaticAssetLifecycleSource(input: Readonly<{
    registry: Pick<ResolvedContributionRegistry, 'uiViewsV2' | 'uiRenderersV2' | 'hostedWeb' | 'uiArtifacts'>;
    sessionId: string;
    machineId: string;
    readTextFile?: (path: string) => Promise<string>;
}>): Promise<HostedWebStaticAssetLifecycleSourceResult> {
    const diagnostics: HostedWebStaticAssetLifecycleSourceDiagnostic[] = [];
    const contributions: HostedWebStaticAssetLifecycleContribution[] = [];
    const artifacts = input.registry.uiArtifacts ?? [];
    const readTextFile = input.readTextFile ?? (async (path) => await readFile(path, 'utf8'));
    const v2OwnedContributionKeys = new Set<string>();

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
        v2OwnedContributionKeys.add(`${pluginId}\0${contributionId}`);
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
        if (generated.entry.hostUiApiVersion !== PLUGIN_UI_HOST_API_VERSION_V1) {
            diagnostics.push(diagnostic({
                code: 'hosted_web_static_artifact_host_api_mismatch',
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

    for (const contribution of input.registry.hostedWeb ?? []) {
        const pluginId = contribution.pluginId;
        if (!pluginId || contribution.definition.service.kind !== 'staticAssets') {
            continue;
        }
        if (v2OwnedContributionKeys.has(`${pluginId}\0${contribution.definition.id}`)) {
            continue;
        }

        const artifact = findHostedWebArtifact({ contribution, artifacts });
        if (!artifact) {
            diagnostics.push(diagnostic({
                code: 'hosted_web_static_artifact_missing',
                pluginId,
                contributionId: contribution.definition.id,
            }));
            continue;
        }

        const pluginRootPath = contributionPluginRoot(contribution)
            ?? artifactPluginRoot(artifact);
        if (!pluginRootPath) {
            diagnostics.push(diagnostic({
                code: 'hosted_web_static_asset_plugin_root_unavailable',
                pluginId,
                contributionId: contribution.definition.id,
            }));
            continue;
        }

        const installedRoot = join(pluginRootPath, HOSTED_WEB_UI_ARTIFACTS_ROOT_RELATIVE_PATH);
        const manifest = await readUiArtifactsManifest({
            installedRoot,
            readTextFile,
        });
        if (!manifest.ok) {
            diagnostics.push(diagnostic({
                code: 'hosted_web_ui_artifacts_manifest_read_failed',
                pluginId,
                contributionId: contribution.definition.id,
            }));
            continue;
        }

        const artifactDigest = artifact.definition.integrity?.digest;
        if (!artifactDigest) {
            diagnostics.push(diagnostic({
                code: 'hosted_web_static_artifact_integrity_missing',
                pluginId,
                contributionId: contribution.definition.id,
            }));
            continue;
        }

        contributions.push(Object.freeze({
            pluginId,
            contributionId: contribution.definition.id,
            sessionId: input.sessionId,
            machineId: input.machineId,
            title: resolveContributionTitle(contribution),
            installedRoot,
            runtimeMode: Object.freeze({
                kind: 'installedStaticAssets' as const,
                artifactId: artifact.definition.id,
                assetRootId: contribution.definition.service.assetRootId,
            }),
            artifactManifest: manifest.manifest,
            artifact: toExecutableArtifactManifest({
                pluginId,
                artifact: artifact.definition,
            }),
            routeMode: contribution.definition.entry.routeMode,
            security: contribution.definition.security,
            sourceMaps: resolvePluginHostedWebSourceMapPolicyV1({
                security: contribution.definition.security,
                digest: artifactDigest,
                internalChannel: artifact.definition.channel === 'internal',
            }),
        }));
    }

    return Object.freeze({
        contributions: Object.freeze(contributions),
        diagnostics: Object.freeze(diagnostics),
    });
}
