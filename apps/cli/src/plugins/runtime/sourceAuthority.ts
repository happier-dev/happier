import { normalizePluginSourceCustodyV1, pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import type { BundledFirstPartyPluginSourceCustodyV1, BundledPackagedRuntimeCustodyV1, DevelopmentPluginSourceCustodyV1, ManagedPluginSourceCustodyV1, PluginSourceCustodyV1 } from '@happier-dev/protocol';
import { PluginSourceCustodyV1Schema } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import { z } from 'zod/mini';
import { asHostProtocolZod } from './protocolComposableZodAdapter';

/** Portable Account/UI declarations do not establish a Machine executable root. */
export type MachinePluginSourceCustody = ManagedPluginSourceCustodyV1 | DevelopmentPluginSourceCustodyV1 | Readonly<{
    kind: 'bundled_first_party';
    packagedRuntime: Extract<BundledPackagedRuntimeCustodyV1, { kind: 'cli_version_root' | 'pinned_runner_snapshot' }>;
}>;

export function isMachinePluginSourceCustody(custody: PluginSourceCustodyV1): custody is MachinePluginSourceCustody {
    return custody.kind === 'managed' || custody.kind === 'development'
        || (custody.kind === 'bundled_first_party'
            && (custody.packagedRuntime.kind === 'cli_version_root'
                || custody.packagedRuntime.kind === 'pinned_runner_snapshot'));
}

export const MachinePluginSourceCustodySchema = z.pipe(
    asHostProtocolZod(PluginSourceCustodyV1Schema),
    z.transform((custody, context): MachinePluginSourceCustody => {
        if (isMachinePluginSourceCustody(custody)) return custody;
        context.issues.push({ code: 'custom', message: 'Plugin custody does not establish a Machine executable source', input: custody });
        return z.NEVER;
    }),
);

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
    | (Extract<PluginSourceCustodyV1, { kind: 'account_release' }> & { resolvedRoot: string })
>;

/** A retained review and runtime publication use the same observed-source fact. */
export function developmentSourceAuthorityEqual(
    reviewed: Extract<PluginRuntimeSourceAuthority, { kind: 'development' }>,
    current: Extract<PluginRuntimeSourceAuthority, { kind: 'development' }> | null | undefined,
): boolean {
    return current?.registeredRootId === reviewed.registeredRootId
        && current.canonicalRoot === reviewed.canonicalRoot
        && current.observedRevision === reviewed.observedRevision;
}

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
        case 'account_release':
            return normalizePluginSourceCustody({ kind: authority.kind, pluginId: authority.pluginId,
                version: authority.version, archiveDigestSha256: authority.archiveDigestSha256 });
    }
}
