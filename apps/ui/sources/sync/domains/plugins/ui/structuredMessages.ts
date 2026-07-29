type UnknownRecord = Readonly<Record<string, unknown>>;

export type PluginUiStructuredMessageProjection = UnknownRecord & Readonly<{
    id: string;
    pluginId: string;
    contributionKind: 'structuredMessage';
    descriptorId: string;
    kind: string;
    fallback: Readonly<{ kind: 'summary'; template: string } | { kind: 'hidden' }>;
}>;

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function isStructuredMessage(entry: UnknownRecord): entry is PluginUiStructuredMessageProjection {
    const fallback = entry.fallback && typeof entry.fallback === 'object' && !Array.isArray(entry.fallback)
        ? entry.fallback as UnknownRecord
        : null;
    return entry.contributionKind === 'structuredMessage'
        && readString(entry.id) !== null
        && readString(entry.pluginId) !== null
        && readString(entry.descriptorId) !== null
        && readString(entry.kind) !== null
        && (fallback?.kind === 'hidden'
            || (fallback?.kind === 'summary' && typeof fallback.template === 'string'));
}

/**
 * Records a projected structured-message descriptor under its transcript kind.
 *
 * The CLI projection omits the entry entirely when the
 * `plugins.ui.structuredMessages` FeatureDecision is not `enabled`, so a missing
 * kind here means the host renders the stable fallback rather than mounting a
 * plugin renderer.
 */
export function addStructuredMessageToKindMap(
    structuredMessagesByKind: Record<string, PluginUiStructuredMessageProjection>,
    entry: PluginUiStructuredMessageProjection,
): void {
    structuredMessagesByKind[entry.kind] = Object.freeze(entry);
}
