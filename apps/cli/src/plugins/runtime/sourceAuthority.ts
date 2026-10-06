import { normalizePluginSourceCustodyV1, pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import type { BundledFirstPartyPluginSourceCustodyV1, BundledPackagedRuntimeCustodyV1, DevelopmentPluginSourceCustodyV1, ManagedPluginSourceCustodyV1, PluginSourceCustodyV1 } from '@happier-dev/protocol';

export { PluginSourceCustodyV1Schema, normalizePluginSourceCustodyV1, pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
export type {
    BundledFirstPartyPluginSourceCustodyV1,
    BundledPackagedRuntimeCustodyV1,
    DevelopmentPluginSourceCustodyV1,
    ManagedPluginSourceCustodyV1,
    PluginSourceCustodyV1,
} from '@happier-dev/protocol';

export type ManagedPluginSourceCustody = ManagedPluginSourceCustodyV1;
export type BundledPackagedRuntimeCustody = BundledPackagedRuntimeCustodyV1;
export type BundledFirstPartyPluginSourceCustody = BundledFirstPartyPluginSourceCustodyV1;
export type DevelopmentPluginSourceCustody = DevelopmentPluginSourceCustodyV1;
/** Durable authority for resolving plugin bytes after a process restart. */
export type PluginSourceCustody = PluginSourceCustodyV1;

export const normalizePluginSourceCustody = normalizePluginSourceCustodyV1;
export const pluginSourceCustodyEqual = pluginSourceCustodyV1Equal;

export type PluginRuntimeSourceAuthority = Readonly<
    | (ManagedPluginSourceCustody & { resolvedRoot: string })
    | (BundledFirstPartyPluginSourceCustody & { resolvedRoot: string })
    | (DevelopmentPluginSourceCustody & {
        canonicalRoot: string;
        observedRevision: number;
    })
>;

function requireNonEmptyString(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${label} must be a non-empty string`);
    }
    return value.trim();
}

/** Binds durable custody to process-local candidate resolution facts. */
export function bindPluginRuntimeSourceAuthority(input: Readonly<{
    custody: PluginSourceCustody;
    resolvedRoot: string;
    observedRevision?: number;
}>): PluginRuntimeSourceAuthority {
    const custody = normalizePluginSourceCustody(input.custody);
    const resolvedRoot = requireNonEmptyString(input.resolvedRoot, 'resolved plugin root');
    if (custody.kind === 'development') {
        if (!Number.isSafeInteger(input.observedRevision) || (input.observedRevision ?? -1) < 0) {
            throw new Error('Development source authority requires a non-negative observed revision');
        }
        return Object.freeze({
            ...custody,
            canonicalRoot: resolvedRoot,
            observedRevision: input.observedRevision!,
        });
    }
    if (input.observedRevision !== undefined) {
        throw new Error('Observed revision belongs only to development source authority');
    }
    return Object.freeze({ ...custody, resolvedRoot });
}

/** Removes process-local resolution facts before a binding crosses a restart. */
export function resolvePluginSourceCustody(authority: PluginRuntimeSourceAuthority): PluginSourceCustody {
    switch (authority.kind) {
        case 'managed':
            return normalizePluginSourceCustody({
                kind: authority.kind,
                immutableGenerationId: authority.immutableGenerationId,
                installSource: authority.installSource,
            });
        case 'bundled_first_party':
            return normalizePluginSourceCustody({ kind: authority.kind, packagedRuntime: authority.packagedRuntime });
        case 'development':
            return normalizePluginSourceCustody({ kind: authority.kind, registeredRootId: authority.registeredRootId });
    }
}
