import {
    ComposerSurfaceMountBindingV1Schema,
    matchesPluginUiDestinationBindingV1,
    type ComposerSurfaceMountBindingV1,
    type PluginUiDestinationBindingV1,
    type PluginUiMountContextV1,
    type PluginUiTargetedContributionSurfaceV1,
} from '@happier-dev/protocol/plugins/ui';
import type {
    DaemonPluginUiComposerSurfaceCatalogEntryV1,
    DaemonPluginUiTargetedSurfaceMountV1,
} from '@happier-dev/protocol';
import { readDaemonPluginUiTargetedSurfaceMountV1 } from '@happier-dev/protocol';

/**
 * The minimum producer facts the host needs to verify a destination mount.
 *
 * This deliberately names no renderer implementation, artifact, Host API,
 * lifecycle, currentness, or crash state. Those stay with their incumbent
 * owners below `PluginSurfaceHost`; this owner only carries the admitted mount
 * facts to them unchanged.
 */
export type PluginSurfaceMountDescriptor = Readonly<{
    pluginId: string;
    descriptorId: string;
    binding?: unknown;
}>;

/** The Registry-normalized destination arm of the generalized mount seam. */
export type PluginSurfaceDestinationMountBinding<
    TDescriptor extends PluginSurfaceMountDescriptor = PluginSurfaceMountDescriptor,
> = Readonly<{
    kind: 'destination';
    descriptor: TDescriptor;
    renderer: Readonly<Record<string, unknown>>;
    destinationBinding: PluginUiDestinationBindingV1;
}>;

/**
 * One daemon-selected embedded mount, rematched against the current public A
 * snapshot before the physical host consumes any B-private renderer fact.
 *
 * The selected renderer is producer-owned: this binding does not select a
 * fallback, interpret input, or resolve an alternate contributor.
 */
export type PluginSurfaceTargetedMountBinding<
    TMount extends DaemonPluginUiTargetedSurfaceMountV1 = DaemonPluginUiTargetedSurfaceMountV1,
> = Readonly<{
    kind: 'targetedSurface';
    mount: TMount;
    renderer: TMount['selectedRenderer']['renderer'];
}>;

/**
 * One host-stamped Composer mount paired with the daemon's one exact current
 * renderer selection. The catalog remains the renderer/origin owner; this
 * binding only proves that its static facts still match the live Composer
 * scope, instance, and closed launch input supplied by the UI owner.
 */
export type PluginSurfaceComposerMountBinding<
    TMount extends ComposerSurfaceMountBindingV1 = ComposerSurfaceMountBindingV1,
    TCatalogEntry extends DaemonPluginUiComposerSurfaceCatalogEntryV1 = DaemonPluginUiComposerSurfaceCatalogEntryV1,
> = Readonly<{
    kind: 'composer';
    mount: TMount;
    catalogEntry: TCatalogEntry;
    renderer: TCatalogEntry['selectedRenderer']['renderer'];
}>;

/**
 * Destination and target mounts join at this one discriminated seam. The
 * target arm carries Main's exact selected candidate; consumers cannot turn it
 * into a destination or repeat selection.
 */
export type PluginSurfaceMountBinding<
    TDescriptor extends PluginSurfaceMountDescriptor = PluginSurfaceMountDescriptor,
    TTargetedMount extends DaemonPluginUiTargetedSurfaceMountV1 = DaemonPluginUiTargetedSurfaceMountV1,
    TComposerMount extends ComposerSurfaceMountBindingV1 = ComposerSurfaceMountBindingV1,
    TComposerCatalogEntry extends DaemonPluginUiComposerSurfaceCatalogEntryV1 = DaemonPluginUiComposerSurfaceCatalogEntryV1,
> = PluginSurfaceDestinationMountBinding<TDescriptor>
    | PluginSurfaceTargetedMountBinding<TTargetedMount>
    | PluginSurfaceComposerMountBinding<TComposerMount, TComposerCatalogEntry>;

/**
 * Project the one public destination mount fact from the admitted binding the
 * host already verified. Callers cannot supply a container or destination: an
 * embedded arm will enter this physical seam only through its own normalized
 * producer, never by pretending to be a destination.
 */
export function createPluginSurfaceDestinationMountContext<
    TDescriptor extends PluginSurfaceMountDescriptor,
>(
    mount: PluginSurfaceDestinationMountBinding<TDescriptor>,
): PluginUiMountContextV1 {
    return Object.freeze({
        kind: 'destination',
        destination: mount.destinationBinding.destination,
        container: mount.destinationBinding.container,
    });
}

/**
 * The public embedded mount is derived only from the exact producer-selected
 * private candidate. It deliberately names no destination/container, so an
 * embedded target can never enter destination navigation or restoration.
 */
export function createPluginSurfaceTargetedMountContext<
    TMount extends DaemonPluginUiTargetedSurfaceMountV1,
>(
    mount: PluginSurfaceTargetedMountBinding<TMount>,
): PluginUiMountContextV1 {
    return Object.freeze({
        kind: 'embedded',
        role: mount.mount.role,
        presentation: mount.mount.presentation,
    });
}

/**
 * Composer mounts are embedded content surfaces. Their compact/popover/dialog
 * geometry belongs to the incumbent control, attachment-row, or presentation
 * owner rather than the generic mount context, which must not invent a
 * destination/container for a Composer scope.
 */
export function createPluginSurfaceComposerMountContext<
    TMount extends ComposerSurfaceMountBindingV1,
    TCatalogEntry extends DaemonPluginUiComposerSurfaceCatalogEntryV1,
>(
    mount: PluginSurfaceComposerMountBinding<TMount, TCatalogEntry>,
): PluginUiMountContextV1 {
    return Object.freeze({
        kind: 'embedded',
        role: mount.mount.role,
        presentation: 'content',
    });
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function readOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readRendererBindingId(renderer: Readonly<Record<string, unknown>>): string | null {
    return readOptionalString(renderer.contributionId) ?? null;
}

function sameContributionIdentity(
    left: Readonly<{ pluginId: string; localId: string }>,
    right: Readonly<{ pluginId: string; localId: string }>,
): boolean {
    return left.pluginId === right.pluginId && left.localId === right.localId;
}

function sameComposerRendererChain(
    left: readonly Readonly<{ pluginId: string; localId: string }>[],
    right: readonly Readonly<{ pluginId: string; localId: string }>[],
): boolean {
    return left.length === right.length
        && left.every((renderer, index) => {
            const candidate = right[index];
            return candidate !== undefined && sameContributionIdentity(renderer, candidate);
        });
}

/**
 * Read one mount from the cold target-semantic projection for the exact
 * currently mounted target. The data-only public contribution snapshot is
 * intentionally not an admission input here: the Registry has already
 * selected this mount after target-owned semantic decoding. Both a missing
 * candidate and a duplicate candidate fail closed; consumers must never pick
 * an arbitrary renderer/order after target admission.
 */
export function readPluginSurfaceTargetedMountBinding<
    TMount extends DaemonPluginUiTargetedSurfaceMountV1,
>(input: Readonly<{
    mounts: readonly TMount[];
    target: TMount['target'];
    surface: PluginUiTargetedContributionSurfaceV1;
}>): PluginSurfaceTargetedMountBinding<TMount> | null {
    const mount = readDaemonPluginUiTargetedSurfaceMountV1(input);
    if (!mount) return null;
    return Object.freeze({
        kind: 'targetedSurface',
        mount,
        renderer: mount.selectedRenderer.renderer,
    });
}

function matchesComposerSurfaceCatalogEntry(
    mount: ComposerSurfaceMountBindingV1,
    catalogEntry: DaemonPluginUiComposerSurfaceCatalogEntryV1,
): boolean {
    return sameContributionIdentity(mount.contribution, catalogEntry.contribution)
        && mount.immutableGenerationId === catalogEntry.immutableGenerationId
        && mount.projectionGeneration === catalogEntry.projectionGeneration
        && mount.role === catalogEntry.role
        && sameContributionIdentity(mount.selectedRenderer, catalogEntry.selectedRenderer.identity)
        && sameComposerRendererChain(mount.rendererChain, catalogEntry.rendererChain);
}

/**
 * Read one exact Composer mount from the current daemon catalog. The caller
 * supplies only the already-decoded current catalog response; this adapter
 * never retains it, chooses a fallback renderer, or derives a renderer/origin
 * from a broad UI projection. A stale/mutated host mount, missing catalog row,
 * or duplicate row fails closed before the physical host can create effects.
 */
export function readPluginSurfaceComposerMountBinding<
    TMount extends ComposerSurfaceMountBindingV1,
    TCatalogEntry extends DaemonPluginUiComposerSurfaceCatalogEntryV1,
>(input: Readonly<{
    mount: TMount;
    catalogEntries: readonly TCatalogEntry[];
}>): PluginSurfaceComposerMountBinding<TMount, TCatalogEntry> | null {
    // The mount is host-stamped but may have crossed an opaque UI boundary;
    // retain its identity rather than a parsed clone once the closed input
    // relation (role/contribution/composer) has been revalidated.
    if (!ComposerSurfaceMountBindingV1Schema.safeParse(input.mount).success) return null;

    const catalogEntries = input.catalogEntries.filter((catalogEntry) => (
        matchesComposerSurfaceCatalogEntry(input.mount, catalogEntry)
    ));
    if (catalogEntries.length !== 1) return null;

    const catalogEntry = catalogEntries[0]!;
    return Object.freeze({
        kind: 'composer',
        mount: input.mount,
        catalogEntry,
        renderer: catalogEntry.selectedRenderer.renderer,
    });
}

/**
 * Read the already-normalized destination mount binding without selecting,
 * normalizing, or cloning any fact. The Registry/CLI remains the only
 * destination admission owner; a mismatch returns `null` so its consumer can
 * fail closed before it constructs a controller, loader, or renderer.
 */
export function readPluginSurfaceMountBinding<
    TDescriptor extends PluginSurfaceMountDescriptor,
>(input: Readonly<{
    descriptor: TDescriptor;
    renderer: Readonly<Record<string, unknown>>;
}>): PluginSurfaceMountBinding<TDescriptor> | null {
    const binding = input.descriptor.binding;
    const bindingRecord = readRecord(binding);
    const destination = readRecord(bindingRecord?.destination);
    const container = readOptionalString(bindingRecord?.container);
    const targetKind = readOptionalString(bindingRecord?.targetKind);
    const rendererId = readRendererBindingId(input.renderer);
    if (
        !bindingRecord
        || !destination
        || !container
        || !targetKind
        || !rendererId
        || readOptionalString(destination.pluginId) !== input.descriptor.pluginId
        || readOptionalString(destination.localId) !== input.descriptor.descriptorId
        || !matchesPluginUiDestinationBindingV1(binding, {
            container,
            targetKind,
            pluginId: input.descriptor.pluginId,
            rendererId,
        })
    ) {
        return null;
    }

    return Object.freeze({
        kind: 'destination',
        descriptor: input.descriptor,
        renderer: input.renderer,
        destinationBinding: binding,
    });
}
