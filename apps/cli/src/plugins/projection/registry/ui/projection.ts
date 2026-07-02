import { createHash } from 'node:crypto';

import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';
import type {
    ResolvedContributionRegistry,
    ResolvedHostedWebContribution,
    ResolvedReactNativeBundleContribution,
    ResolvedSessionHeaderActionContribution,
    ResolvedSessionSurfaceContribution,
    ResolvedStructuredMessageContribution,
    ResolvedUiArtifactContribution,
    ResolvedUiTranslationsContribution,
} from '../types';

type PluginUiProjectedEntry = Readonly<Record<string, unknown> & {
    id: string;
    pluginId?: string;
    contributionKind: string;
}>;

function digestJson(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function readPluginId(entry: Readonly<{ pluginId?: string }>): string | null {
    const pluginId = entry.pluginId?.trim();
    return pluginId && pluginId.length > 0 ? pluginId : null;
}

function addEntry(
    entriesById: Record<string, PluginUiProjectedEntry>,
    entry: PluginUiProjectedEntry,
): void {
    entriesById[entry.id] = Object.freeze(entry);
}

function projectTranslations(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntry>,
): void {
    for (const contribution of registry.uiTranslations ?? []) {
        const pluginId = readPluginId(contribution);
        if (!pluginId) {
            continue;
        }
        const id = `translations:${pluginId}`;
        addEntry(entriesById, {
            id,
            pluginId,
            contributionKind: 'translations',
            defaultLocale: contribution.definition.defaultLocale,
            locales: Object.keys(contribution.definition.locales).sort(),
            bundles: contribution.definition.locales,
        });
    }
}

function projectStructuredMessages(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntry>,
): void {
    for (const contribution of registry.structuredMessages ?? []) {
        const pluginId = readPluginId(contribution);
        if (!pluginId) {
            continue;
        }
        const id = `structuredMessage:${pluginId}:${contribution.definition.id}`;
        addEntry(entriesById, {
            id,
            pluginId,
            contributionKind: 'structuredMessage',
            descriptorId: contribution.definition.id,
            kind: contribution.definition.kind,
            payloadSchema: contribution.definition.payloadSchema,
            renderer: contribution.definition.renderer,
            display: contribution.definition.display,
            actions: contribution.definition.actions,
            visibility: contribution.definition.visibility,
            featureGate: contribution.definition.featureGate,
            order: contribution.definition.order,
            compatibility: contribution.definition.compatibility,
        });
    }
}

function projectSessionSurfaces(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntry>,
): void {
    for (const contribution of registry.sessionSurfaces ?? []) {
        const pluginId = readPluginId(contribution);
        if (!pluginId) {
            continue;
        }
        const id = `sessionSurface:${pluginId}:${contribution.definition.id}`;
        addEntry(entriesById, {
            id,
            pluginId,
            contributionKind: 'sessionSurface',
            descriptorId: contribution.definition.id,
            surfaceKind: contribution.definition.surfaceKind,
            target: contribution.definition.target,
            renderer: contribution.definition.renderer,
            display: contribution.definition.display,
            visibility: contribution.definition.visibility,
            enabled: contribution.definition.enabled,
            order: contribution.definition.order,
            badge: contribution.definition.badge,
            actions: contribution.definition.actions,
            fallback: contribution.definition.fallback,
            compatibility: contribution.definition.compatibility,
        });
    }
}

function projectSessionHeaderActions(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntry>,
): void {
    for (const contribution of registry.sessionHeaderActions ?? []) {
        const pluginId = readPluginId(contribution);
        if (!pluginId) {
            continue;
        }
        const id = `sessionHeaderAction:${pluginId}:${contribution.definition.id}`;
        addEntry(entriesById, {
            id,
            pluginId,
            contributionKind: 'sessionHeaderAction',
            descriptorId: contribution.definition.id,
            action: contribution.definition.action,
            display: contribution.definition.display,
            placement: contribution.definition.placement,
            visibility: contribution.definition.visibility,
            enabled: contribution.definition.enabled,
            badge: contribution.definition.badge,
            order: contribution.definition.order,
            compatibility: contribution.definition.compatibility,
        });
    }
}

function projectHostedWeb(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntry>,
): void {
    for (const contribution of registry.hostedWeb ?? []) {
        const pluginId = readPluginId(contribution);
        if (!pluginId) {
            continue;
        }
        const id = `hostedWeb:${pluginId}:${contribution.definition.id}`;
        addEntry(entriesById, {
            id,
            pluginId,
            contributionKind: 'hostedWeb',
            contributionId: contribution.definition.id,
            service: contribution.definition.service,
            entry: contribution.definition.entry,
            bridge: contribution.definition.bridge,
            sandbox: contribution.definition.sandbox,
            display: contribution.definition.display,
            compatibility: contribution.definition.compatibility,
            fallback: contribution.definition.fallback,
        });
    }
}

function projectReactNativeBundles(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntry>,
): void {
    for (const contribution of registry.reactNativeBundles ?? []) {
        const pluginId = readPluginId(contribution);
        if (!pluginId) {
            continue;
        }
        const id = `reactNativeBundle:${pluginId}:${contribution.definition.id}`;
        addEntry(entriesById, {
            id,
            pluginId,
            contributionKind: 'reactNativeBundle',
            contributionId: contribution.definition.id,
            bundle: contribution.definition.bundle,
            entry: contribution.definition.entry,
            compatibility: contribution.definition.compatibility,
            hostApi: contribution.definition.hostApi,
            nativeCapabilities: contribution.definition.nativeCapabilities,
            fallback: contribution.definition.fallback,
            display: contribution.definition.display,
            policy: contribution.definition.policy,
        });
    }
}

function projectUiArtifacts(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntry>,
): void {
    for (const contribution of registry.uiArtifacts ?? []) {
        const pluginId = readPluginId(contribution);
        if (!pluginId) {
            continue;
        }
        const id = `uiArtifact:${pluginId}:${contribution.definition.id}`;
        addEntry(entriesById, {
            id,
            pluginId,
            contributionKind: 'uiArtifact',
            artifactId: contribution.definition.id,
            contributionId: contribution.definition.contributionId,
            contributionFamily: contribution.definition.contributionFamily,
            artifactKind: contribution.definition.artifactKind,
            platform: contribution.definition.platform,
            channel: contribution.definition.channel,
            integrity: contribution.definition.integrity,
            compatibility: contribution.definition.compatibility,
            byteSize: contribution.definition.byteSize,
            contentType: contribution.definition.contentType,
            assetPath: contribution.definition.assetPath,
            url: contribution.definition.url,
            cacheKey: contribution.definition.cacheKey,
            revokedAt: contribution.definition.revokedAt,
        });
    }
}

function addDigestEntries(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntry>,
): void {
    const byPluginId = new Map<string, {
        translations: ResolvedUiTranslationsContribution[];
        structuredMessages: ResolvedStructuredMessageContribution[];
        sessionSurfaces: ResolvedSessionSurfaceContribution[];
        sessionHeaderActions: ResolvedSessionHeaderActionContribution[];
        hostedWeb: ResolvedHostedWebContribution[];
        reactNativeBundles: ResolvedReactNativeBundleContribution[];
        uiArtifacts: ResolvedUiArtifactContribution[];
    }>();

    function bucket(pluginId: string) {
        const existing = byPluginId.get(pluginId);
        if (existing) {
            return existing;
        }
        const created = {
            translations: [],
            structuredMessages: [],
            sessionSurfaces: [],
            sessionHeaderActions: [],
            hostedWeb: [],
            reactNativeBundles: [],
            uiArtifacts: [],
        };
        byPluginId.set(pluginId, created);
        return created;
    }

    for (const contribution of registry.uiTranslations ?? []) {
        const pluginId = readPluginId(contribution);
        if (pluginId) bucket(pluginId).translations.push(contribution);
    }
    for (const contribution of registry.structuredMessages ?? []) {
        const pluginId = readPluginId(contribution);
        if (pluginId) bucket(pluginId).structuredMessages.push(contribution);
    }
    for (const contribution of registry.sessionSurfaces ?? []) {
        const pluginId = readPluginId(contribution);
        if (pluginId) bucket(pluginId).sessionSurfaces.push(contribution);
    }
    for (const contribution of registry.sessionHeaderActions ?? []) {
        const pluginId = readPluginId(contribution);
        if (pluginId) bucket(pluginId).sessionHeaderActions.push(contribution);
    }
    for (const contribution of registry.hostedWeb ?? []) {
        const pluginId = readPluginId(contribution);
        if (pluginId) bucket(pluginId).hostedWeb.push(contribution);
    }
    for (const contribution of registry.reactNativeBundles ?? []) {
        const pluginId = readPluginId(contribution);
        if (pluginId) bucket(pluginId).reactNativeBundles.push(contribution);
    }
    for (const contribution of registry.uiArtifacts ?? []) {
        const pluginId = readPluginId(contribution);
        if (pluginId) bucket(pluginId).uiArtifacts.push(contribution);
    }

    for (const [pluginId, contributions] of [...byPluginId.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        const id = `digest:${pluginId}`;
        addEntry(entriesById, {
            id,
            pluginId,
            contributionKind: 'digest',
            digest: digestJson(contributions),
            families: Object.fromEntries(
                Object.entries(contributions).map(([family, familyContributions]) => [
                    family,
                    digestJson(familyContributions),
                ]),
            ),
        });
    }
}

export const pluginUiProjectionFamily = definePluginProjectionFamilyV2({
    family: 'pluginUi',
    project({ registry }) {
        const entriesById: Record<string, PluginUiProjectedEntry> = {};
        projectTranslations(registry, entriesById);
        projectStructuredMessages(registry, entriesById);
        projectSessionSurfaces(registry, entriesById);
        projectSessionHeaderActions(registry, entriesById);
        projectHostedWeb(registry, entriesById);
        projectReactNativeBundles(registry, entriesById);
        projectUiArtifacts(registry, entriesById);
        addDigestEntries(registry, entriesById);

        return {
            family: 'pluginUi',
            entriesById,
        };
    },
});
