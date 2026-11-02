import type { PluginProjectionInstalledPackageV2 } from '@happier-dev/protocol';

function readOptionalString(value: unknown): string | undefined {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized.length > 0 ? normalized : undefined;
}

/** One source presentation for admitted declarations and catalog fallbacks. */
export function projectPluginContributionSource(metadata: Readonly<{
    pluginId: string;
    sourceKind?: string;
    sourceSpec?: Readonly<{ kind?: string; locator?: string }>;
    manifestPath?: string;
}>): PluginProjectionInstalledPackageV2['source'] {
    const kind = metadata.sourceKind ?? readOptionalString(metadata.sourceSpec?.kind);
    // Preserve the catalog's existing legacy-placeholder semantics. These
    // values cannot assert a real installed package provenance.
    const sourceKind = kind === 'package' || kind === 'marketplace' ? 'unknown' : kind ?? 'unknown';
    const locator = sourceKind === 'bundled' ? metadata.pluginId
        : readOptionalString(metadata.sourceSpec?.locator)
            ?? readOptionalString(metadata.manifestPath) ?? metadata.pluginId;
    return { kind: sourceKind, locator };
}
