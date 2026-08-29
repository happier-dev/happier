import type {
    PackageAssetArchiveDescriptorV1,
    PluginAccountAvailabilityIntentReadResponseV1,
    PluginMachineMaterializationSnapshotV1,
    PluginMachineMaterializationV1,
    PluginMachineMaterializationRefV1,
    PluginPortableReleaseManifestV1,
} from '@happier-dev/protocol/plugins/availability';
import {
    isExactPluginMachineMaterializationReleaseCorrespondenceV1,
    isPluginUiReleaseSlotCompatibleWithArtifactLinkV1,
    normalizePluginReleaseFactsV1,
} from '@happier-dev/protocol/plugins/availability';
import type {
    PluginUiArtifactCompatibilityKeyV1,
    PluginUiArtifactDigestV1,
} from '@happier-dev/protocol/plugins/ui';
import type { PluginCollectionContractRefV1 } from '@happier-dev/protocol';

import {
    areServerAccountScopesEqual,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';

import type { BundledPluginUiAppArtifactInventory } from './bundledPluginUiArtifactInventory';
import { BUNDLED_PLUGIN_UI_APP_ARTIFACTS } from './generatedBundledPluginUiArtifacts';

/**
 * The app build emits an empty inventory for platforms with no packaged plugin
 * UI, so the generated constant widens to the declared inventory contract here
 * rather than to that build's empty tuple.
 */
const HOST_BUNDLED_PLUGIN_UI_ARTIFACTS: BundledPluginUiAppArtifactInventory =
    BUNDLED_PLUGIN_UI_APP_ARTIFACTS;

export type PluginAccountAvailabilitySnapshot = Readonly<{
    /** The canonical AccountChange ordering fact for this complete projection. */
    availabilityCursor: number;
    /**
     * Exact responses from the canonical Availability intent-read operation,
     * bound to the requested plugin id. This UI projection does not invent an
     * Artifact state: current Artifact facts are derived from its intent,
     * selected release, and qualified Account-hosted link.
     */
    intentReads: readonly PluginAccountAvailabilityIntentReadProjection[];
    /**
     * Presentation/correspondence evidence for Administration. This inventory
     * does not itself grant execution authority or choose an execution source.
     */
    materializations: readonly PluginMachineMaterializationV1[];
    /** Complete per-machine inventory facts, including exact empty reports. */
    snapshots: readonly PluginMachineMaterializationSnapshotV1[];
}>;

export type PluginAccountAvailabilityIntentReadProjection = Readonly<{
    pluginId: string;
    response: PluginAccountAvailabilityIntentReadResponseV1;
}>;

export type PluginAccountAvailabilityArtifactSlot = Readonly<{
    pluginId: string;
    contributionId: string;
    tier: 'declarative' | 'hostedWeb' | 'reactNative';
    platform: 'web' | 'ios' | 'android';
    /** Exact selected daemon materialization; required for bundled-first-party admission. */
    materializationOrigin?: Readonly<{
        serverIdentityId: string;
        materializationRef: PluginMachineMaterializationRefV1;
    }>;
}>;

/** Immutable release-selected bytes facts, independent of any source link. */
export type PluginAccountAvailabilitySelectedArtifactFact = PluginAccountAvailabilityArtifactSlot & Readonly<{
    digest: PluginUiArtifactDigestV1;
    releaseVersion: string;
}>;

/** Source-local Account-hosted link provenance; never a selected-byte identity. */
export type PluginAccountAvailabilityArtifactSourceFact =
    | Readonly<{
        accountArtifactId?: never;
        accountArtifactCompatibility?: never;
    }>
    | Readonly<{
        /** Its compatibility is transient adoption provenance, not release identity. */
        accountArtifactId: string;
        accountArtifactCompatibility: PluginUiArtifactCompatibilityKeyV1;
    }>;

export type PluginAccountAvailabilityArtifactFact = PluginAccountAvailabilitySelectedArtifactFact
    & PluginAccountAvailabilityArtifactSourceFact;

/**
 * Availability's Account-release correspondence for one machine report. The
 * immutable Account release is the only content owner; the report carries its
 * exact producer-bound facts, while Administration remains the only owner of
 * exact-machine selection and local reachability.
 */
export type PluginAccountAvailabilityReleaseClassificationV1 = Readonly<{
    /**
     * Exact producer identity retained beside release validation. Consumers
     * must carry this through selection; they must not reconstruct it from a
     * machine id or a plugin id after the fact.
     */
    serverIdentityId: string;
    materializationRef: PluginMachineMaterializationRefV1;
    releaseContent: 'matched' | 'conflict' | 'unknown';
    validation:
        | Readonly<{ kind: 'admitted' }>
        | Readonly<{
            kind: 'rejected';
            reason: 'disabled' | 'plugin_mismatch' | 'unknown';
        }>;
}>;

export function projectPluginAccountAvailabilityMaterializationIdentity(
    materialization: PluginMachineMaterializationV1,
): Pick<
    PluginAccountAvailabilityReleaseClassificationV1,
    'serverIdentityId' | 'materializationRef'
> {
    return Object.freeze({
        serverIdentityId: materialization.serverIdentityId,
        materializationRef: Object.freeze({
            machineId: materialization.machineId,
            materializationId: materialization.materializationId,
            pluginId: materialization.pluginId,
        }),
    });
}

export type PluginMachineMaterializationAdmission =
    | Readonly<{
        kind: 'available';
        availabilityCursor: number;
        materializations: readonly PluginMachineMaterializationV1[];
        snapshots: readonly PluginMachineMaterializationSnapshotV1[];
    }>
    | Readonly<{
        kind: 'unavailable';
        code: 'account_availability_not_loaded' | 'account_availability_scope_mismatch';
    }>;

export type PluginAccountAvailabilityArtifactAdmission =
    | Readonly<{
        kind: 'available';
        availabilityCursor: number;
        artifact: PluginAccountAvailabilityArtifactFact;
    }>
    | Readonly<{
        kind: 'unavailable';
        code:
            | 'account_availability_not_loaded'
            | 'account_availability_scope_mismatch'
            | 'artifact_not_current'
            | 'artifact_slot_ambiguous';
    }>;

/** The Protocol-owned declared release slot, snapshotted by this projection. */
export type PluginAccountAvailabilityReleaseUiSlot =
    NonNullable<PluginAccountAvailabilityIntentReadResponseV1['release']>['uiSlots'][number];

/**
 * The exact immutable coordinates one present client may publish for. The
 * declared slot carries its portable compatibility so the publisher compares
 * the host's own adoption facts against it instead of restating them.
 */
export type PluginAccountAvailabilityHostedPublicationTarget = Readonly<{
    release: NonNullable<PluginAccountAvailabilityIntentReadResponseV1['release']>['ref'];
    slot: PluginAccountAvailabilityReleaseUiSlot;
}>;

export type PluginAccountAvailabilityHostedPublicationAdmission =
    | Readonly<{
        kind: 'available';
        availabilityCursor: number;
        target: PluginAccountAvailabilityHostedPublicationTarget;
    }>
    | Readonly<{
        kind: 'unavailable';
        code:
            | 'account_availability_not_loaded'
            | 'account_availability_scope_mismatch'
            | 'artifact_not_current'
            | 'artifact_slot_ambiguous'
            | 'artifact_hosting_not_admitted'
            | 'artifact_already_hosted';
    }>;

/**
 * Immutable package-asset facts selected by the current Account release. This
 * carries no Artifact id, transport, cache location, or daemon authority.
 */
export type PluginAccountAvailabilityPackageAssetFact = Readonly<{
    pluginId: string;
    releaseVersion: string;
    descriptor: PluginAccountAvailabilityPackageAssetDescriptor;
}>;

/**
 * The projection retains a deep immutable snapshot of Protocol-owned release
 * facts. It is not another descriptor grammar or byte/cache owner.
 */
export type PluginAccountAvailabilityPackageAssetDescriptor = Readonly<{
    archiveDigestSha256: PackageAssetArchiveDescriptorV1['archiveDigestSha256'];
    resources: readonly Readonly<PackageAssetArchiveDescriptorV1['resources'][number]>[];
}>;

export type PluginAccountAvailabilityPackageAssetAdmission =
    | Readonly<{
        kind: 'available';
        availabilityCursor: number;
        packageAsset: PluginAccountAvailabilityPackageAssetFact;
    }>
    | Readonly<{
        kind: 'unavailable';
        code:
            | 'account_availability_not_loaded'
            | 'account_availability_scope_mismatch'
            | 'artifact_not_current'
            | 'artifact_slot_ambiguous';
    }>;

/**
 * Availability admits an immutable contract reference only. The persisted
 * normalized contract remains Data-owned and is read through the authenticated
 * Data route after this projection has selected the ref.
 */
export type PluginAccountAvailabilityCollectionContractAdmission =
    | Readonly<{
        kind: 'available';
        availabilityCursor: number;
        ref: PluginCollectionContractRefV1;
    }>
    | Readonly<{
        kind: 'unavailable';
        code:
            | 'account_availability_not_loaded'
            | 'account_availability_scope_mismatch'
            | 'artifact_not_current'
            | 'artifact_slot_ambiguous'
            | 'collection_not_current'
            | 'collection_slot_ambiguous';
    }>;

/**
 * An opaque current-release fact for renderer admission. It answers only
 * whether direct Account Collection reads/watch have at least one exact,
 * enabled release contract to target; callers never receive a contract list
 * or mutation grant from this method. Exact contract selection and CAS remain
 * with the Data owner.
 */
export type PluginAccountAvailabilityCollectionCapabilityAdmission =
    | Readonly<{
        kind: 'available';
        availabilityCursor: number;
    }>
    | Readonly<{
        kind: 'unavailable';
        code:
            | 'account_availability_not_loaded'
            | 'account_availability_scope_mismatch'
            | 'artifact_not_current'
            | 'artifact_slot_ambiguous'
            | 'collection_not_current';
    }>;

/**
 * The normalized release declaration can admit Account Settings recovery even
 * while activation is disabled. It neither re-enables a plugin nor conveys a
 * daemon projection, machine selection, or execution capability.
 */
export type PluginAccountAvailabilitySettingsDeclarationAdmission =
    | Readonly<{
        kind: 'available';
        availabilityCursor: number;
        declaration: PluginPortableReleaseManifestV1;
    }>
    | Readonly<{
        kind: 'unavailable';
        code:
            | 'account_availability_not_loaded'
            | 'account_availability_scope_mismatch'
            | 'artifact_not_current'
            | 'artifact_slot_ambiguous';
    }>;

/**
 * The exact present-user Account intent/release pairing consumed by a release
 * selection CAS. It deliberately remains available while `intent.enabled` is
 * false: selection needs its optimistic revision and current source contract,
 * whereas ordinary renderer/Data admission remains enabled-only.
 */
export type PluginAccountAvailabilityReleaseSelectionAdmission =
    | Readonly<{
        kind: 'available';
        availabilityCursor: number;
        intent: NonNullable<PluginAccountAvailabilityIntentReadResponseV1['intent']>;
        release: Readonly<{
            ref: NonNullable<PluginAccountAvailabilityIntentReadResponseV1['release']>['ref'];
            normalizedManifest: PluginPortableReleaseManifestV1;
        }>;
    }>
    | Readonly<{
        kind: 'unavailable';
        code:
            | 'account_availability_not_loaded'
            | 'account_availability_scope_mismatch'
            | 'artifact_not_current'
            | 'artifact_slot_ambiguous';
    }>;

export type PluginAccountAvailabilityReader = Readonly<{
    /**
     * Current expected Artifact identity only. This is intentionally not a
     * byte-source selector: URLs, cache state, source priority, and transport
     * remain private to the Artifact adoption/cache owner.
     */
    readCurrentArtifact: (
        slot: PluginAccountAvailabilityArtifactSlot,
    ) => PluginAccountAvailabilityArtifactAdmission;
    /**
     * Admits one exact declared slot for present-client Account-hosted
     * publication. It is available only while the operator capability, the
     * Account opt-in, and the current release admit hosting and no exact
     * qualified link exists yet. It grants no byte source and no transport.
     */
    readCurrentHostedPublicationTarget: (
        slot: PluginAccountAvailabilityArtifactSlot,
    ) => PluginAccountAvailabilityHostedPublicationAdmission;
    /**
     * Current immutable package-asset declaration for one enabled release.
     * Stored-envelope access remains with the protected Account source.
     */
    readCurrentPackageAsset: (input: Readonly<{
        pluginId: string;
    }>) => PluginAccountAvailabilityPackageAssetAdmission;
    /**
     * Current release admission for one collection's immutable Data ref. This
     * reader never carries the reconstructed normalized contract or chooses a
     * Data transport.
     */
    readCurrentCollectionContract: (input: Readonly<{
        pluginId: string;
        collectionId: string;
    }>) => PluginAccountAvailabilityCollectionContractAdmission;
    /**
     * Current enabled-release capability for direct Account Collection UI.
     * This is intentionally an opaque presence fact, not a reconstructed
     * contract inventory or a mutation authorization.
     */
    readCurrentCollectionCapability: (input: Readonly<{
        pluginId: string;
    }>) => PluginAccountAvailabilityCollectionCapabilityAdmission;
    /**
     * Reads the current normalized release declaration for Account-only
     * Settings recovery. Activation remains a separate daemon concern.
     */
    readCurrentSettingsDeclaration: (input: Readonly<{
        pluginId: string;
    }>) => PluginAccountAvailabilitySettingsDeclarationAdmission;
    /**
     * Admits the exact current source intent/release for a present-user
     * Account release-selection CAS. It is not Artifact admission and grants
     * neither a byte source nor a Data read/write capability.
     */
    readCurrentReleaseSelection: (input: Readonly<{
        pluginId: string;
    }>) => PluginAccountAvailabilityReleaseSelectionAdmission;
    /**
     * Validates immutable Account release facts against a materialization's
     * explicit correspondence/status. It cannot select a machine or infer
     * transport/source authority.
     */
    classifyRelease: (
        materialization: PluginMachineMaterializationV1,
    ) => PluginAccountAvailabilityReleaseClassificationV1;
    readMaterializations: () => PluginMachineMaterializationAdmission;
    /**
     * A lifecycle signal only. Consumers re-read through this owner; they
     * never receive a raw snapshot or a second currentness owner.
     */
    subscribe: (listener: () => void) => () => void;
}>;

export type PluginAccountAvailabilityReaderStore = Readonly<{
    replace: (input: Readonly<{
        scope: ServerAccountScope;
        snapshot: PluginAccountAvailabilitySnapshot;
    }>) => PluginAccountAvailabilityStoredProjection | null;
    clear: () => PluginAccountAvailabilityStoredProjection | null;
    subscribe: (listener: () => void) => () => void;
    /**
     * Binds a caller to one Account/realm without disclosing that scope to a
     * renderer. If this store moves to another Account, the retained reader is
     * typed unavailable instead of reading the new Account's projection.
     */
    bind: (scope: ServerAccountScope) => PluginAccountAvailabilityReader;
}>;

/**
 * The frozen prior projection returned only to the projection lifecycle owner
 * while it replaces or clears its own store. Readers still expose facts, not
 * raw Availability snapshots, to their consumers.
 */
export type PluginAccountAvailabilityStoredProjection = Readonly<{
    scope: ServerAccountScope;
    snapshot: PluginAccountAvailabilitySnapshot;
}>;

type AvailabilityProjectionState = PluginAccountAvailabilityStoredProjection;

/**
 * Protocol response types retain mutable-array annotations even though this
 * reader owns an immutable in-memory snapshot. Freeze in place and preserve
 * that external structural type instead of leaking a second readonly model.
 */
function freezeAvailabilitySnapshotValue<T extends object>(value: T): T {
    Object.freeze(value);
    return value;
}

function cloneMaterialization(
    materialization: PluginMachineMaterializationV1,
): PluginMachineMaterializationV1 {
    return freezeAvailabilitySnapshotValue({
        ...materialization,
        uiArtifacts: freezeAvailabilitySnapshotValue(materialization.uiArtifacts.map((artifact) => (
            freezeAvailabilitySnapshotValue({ ...artifact })
        ))),
    });
}

function snapshotIntentReadResponse(
    response: PluginAccountAvailabilityIntentReadResponseV1,
): PluginAccountAvailabilityIntentReadResponseV1 {
    const intent = response.intent
        ? freezeAvailabilitySnapshotValue({
            ...response.intent,
            writableCollections: freezeAvailabilitySnapshotValue(response.intent.writableCollections.map((collection) => (
                freezeAvailabilitySnapshotValue({ ...collection })
            ))),
        })
        : null;
    return freezeAvailabilitySnapshotValue({
        availabilityCursor: response.availabilityCursor,
        hostingCapability: freezeAvailabilitySnapshotValue({ ...response.hostingCapability }),
        intent,
        // Protocol owns the complete immutable release-fact representation.
        // The reader snapshots its remaining projection facts here instead of
        // recreating that normalizer in the UI layer.
        release: response.release ? normalizePluginReleaseFactsV1(response.release) : null,
        uiArtifacts: freezeAvailabilitySnapshotValue(response.uiArtifacts.map((artifact) => (
            freezeAvailabilitySnapshotValue({
                ...artifact,
                release: freezeAvailabilitySnapshotValue({ ...artifact.release }),
                compatibility: freezeAvailabilitySnapshotValue({
                    ...artifact.compatibility,
                    nativeCapabilities: freezeAvailabilitySnapshotValue([
                        ...artifact.compatibility.nativeCapabilities,
                    ]),
                }),
            })
        ))),
    });
}

function cloneSelectionIntent(
    intent: NonNullable<PluginAccountAvailabilityIntentReadResponseV1['intent']>,
): NonNullable<PluginAccountAvailabilityIntentReadResponseV1['intent']> {
    return freezeAvailabilitySnapshotValue({
        ...intent,
        writableCollections: freezeAvailabilitySnapshotValue(intent.writableCollections.map((collection) => (
            freezeAvailabilitySnapshotValue({ ...collection })
        ))),
    });
}

function snapshotPluginAccountAvailabilitySnapshot(
    snapshot: PluginAccountAvailabilitySnapshot,
): PluginAccountAvailabilitySnapshot {
    return freezeAvailabilitySnapshotValue({
        availabilityCursor: snapshot.availabilityCursor,
        intentReads: freezeAvailabilitySnapshotValue(snapshot.intentReads.map((projection) => (
            freezeAvailabilitySnapshotValue({
                pluginId: projection.pluginId,
                response: snapshotIntentReadResponse(projection.response),
            })
        ))),
        materializations: freezeAvailabilitySnapshotValue(snapshot.materializations.map(cloneMaterialization)),
        snapshots: freezeAvailabilitySnapshotValue(snapshot.snapshots.map((machineSnapshot) => (
            freezeAvailabilitySnapshotValue({
                ...machineSnapshot,
                materializations: freezeAvailabilitySnapshotValue(
                    machineSnapshot.materializations.map(cloneMaterialization),
                ),
            })
        ))),
    });
}

function cloneArtifact(artifact: PluginAccountAvailabilityArtifactFact): PluginAccountAvailabilityArtifactFact {
    const selected: PluginAccountAvailabilitySelectedArtifactFact = freezeAvailabilitySnapshotValue({
        pluginId: artifact.pluginId,
        contributionId: artifact.contributionId,
        tier: artifact.tier,
        platform: artifact.platform,
        digest: artifact.digest,
        releaseVersion: artifact.releaseVersion,
    });
    if (!artifact.accountArtifactId || !artifact.accountArtifactCompatibility) {
        return selected;
    }
    const accountArtifactCompatibility: PluginUiArtifactCompatibilityKeyV1 = freezeAvailabilitySnapshotValue({
        ...artifact.accountArtifactCompatibility,
        nativeCapabilities: freezeAvailabilitySnapshotValue([
            ...artifact.accountArtifactCompatibility.nativeCapabilities,
        ]),
    });
    return freezeAvailabilitySnapshotValue({
        ...selected,
        accountArtifactId: artifact.accountArtifactId,
        accountArtifactCompatibility,
    });
}

function readProjectionForScope(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
): PluginAccountAvailabilitySnapshot | null {
    return state && areServerAccountScopesEqual(state.scope, scope)
        ? state.snapshot
        : null;
}

function readMaterializationAdmission(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
): PluginMachineMaterializationAdmission {
    if (!state) {
        return Object.freeze({ kind: 'unavailable', code: 'account_availability_not_loaded' });
    }
    const snapshot = readProjectionForScope(state, scope);
    if (!snapshot) {
        return Object.freeze({ kind: 'unavailable', code: 'account_availability_scope_mismatch' });
    }
    return Object.freeze({
        kind: 'available',
        availabilityCursor: snapshot.availabilityCursor,
        materializations: Object.freeze(snapshot.materializations.map(cloneMaterialization)),
        snapshots: Object.freeze(snapshot.snapshots.map((machineSnapshot) => Object.freeze({
            ...machineSnapshot,
            materializations: Object.freeze(machineSnapshot.materializations.map(cloneMaterialization)),
        }))),
    });
}

type CurrentReleaseAdmission =
    | Readonly<{
        kind: 'available';
        availabilityCursor: number;
        hostingCapability: PluginAccountAvailabilityIntentReadResponseV1['hostingCapability'];
        intent: NonNullable<PluginAccountAvailabilityIntentReadResponseV1['intent']>;
        release: NonNullable<PluginAccountAvailabilityIntentReadResponseV1['release']>;
        uiArtifacts: PluginAccountAvailabilityIntentReadResponseV1['uiArtifacts'];
    }>
    | Readonly<{
        kind: 'unavailable';
        code: Extract<PluginAccountAvailabilityArtifactAdmission, { kind: 'unavailable' }>['code'];
    }>;

function readCurrentReleaseAdmission(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    pluginId: string,
): CurrentReleaseAdmission {
    if (!state) {
        return Object.freeze({ kind: 'unavailable', code: 'account_availability_not_loaded' });
    }
    const snapshot = readProjectionForScope(state, scope);
    if (!snapshot) {
        return Object.freeze({ kind: 'unavailable', code: 'account_availability_scope_mismatch' });
    }
    const projections = snapshot.intentReads.filter((projection) => projection.pluginId === pluginId);
    if (projections.length === 0) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_not_current' });
    }
    if (projections.length !== 1) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_slot_ambiguous' });
    }
    const response = projections[0]!.response;
    const intent = response.intent;
    const release = response.release;
    if (
        response.availabilityCursor !== snapshot.availabilityCursor
        || !intent
        || !intent.desiredVersion
        || intent.pluginId !== pluginId
        || !release
        || release.ref.pluginId !== pluginId
        || release.ref.version !== intent.desiredVersion
    ) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_not_current' });
    }
    return Object.freeze({
        kind: 'available',
        availabilityCursor: snapshot.availabilityCursor,
        hostingCapability: response.hostingCapability,
        intent,
        release,
        uiArtifacts: response.uiArtifacts,
    });
}

function readCurrentReleaseSelectionAdmission(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    input: Readonly<{ pluginId: string }>,
): PluginAccountAvailabilityReleaseSelectionAdmission {
    const current = readCurrentReleaseAdmission(state, scope, input.pluginId);
    if (current.kind !== 'available') return current;
    return Object.freeze({
        kind: 'available',
        availabilityCursor: current.availabilityCursor,
        intent: cloneSelectionIntent(current.intent),
        release: Object.freeze({
            ref: Object.freeze({ ...current.release.ref }),
            normalizedManifest: current.release.normalizedManifest,
        }),
    });
}

function classifyMaterializationRelease(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    materialization: PluginMachineMaterializationV1,
): PluginAccountAvailabilityReleaseClassificationV1 {
    const identity = projectPluginAccountAvailabilityMaterializationIdentity(materialization);
    const current = readCurrentReleaseAdmission(state, scope, materialization.pluginId);
    if (current.kind !== 'available') {
        return Object.freeze({
            ...identity,
            releaseContent: 'unknown',
            validation: Object.freeze({ kind: 'rejected', reason: 'unknown' }),
        });
    }
    if (materialization.pluginId !== current.intent.pluginId) {
        return Object.freeze({
            ...identity,
            releaseContent: 'unknown',
            validation: Object.freeze({ kind: 'rejected', reason: 'plugin_mismatch' }),
        });
    }
    if (!materialization.portableRelease) {
        return Object.freeze({
            ...identity,
            releaseContent: 'unknown',
            validation: Object.freeze({ kind: 'rejected', reason: 'unknown' }),
        });
    }
    const releaseContent = isExactPluginMachineMaterializationReleaseCorrespondenceV1(
        materialization,
        current.release,
    )
        ? 'matched'
        : 'conflict';
    return Object.freeze({
        ...identity,
        releaseContent,
        validation: current.intent.enabled
            ? Object.freeze({ kind: 'admitted' as const })
            : Object.freeze({ kind: 'rejected' as const, reason: 'disabled' as const }),
    });
}

/**
 * The host-bundled authority arm.
 *
 * A first-party plugin that ships inside the host binary has no Account
 * intent and no Account release: the daemon publishes releases only for
 * installed distributions, and an Account intent is a present-user Settings
 * action. Requiring one before its own app-package bytes may be selected is
 * not fail-closed, it is fail-always — it withheld every React Native surface
 * of every host-bundled plugin, on every client.
 *
 * The daemon's exact bundled-first-party machine materialization is the
 * coordinate/currentness authority for these slots. The generated app
 * inventory supplies only the matching packaged bytes after that admission.
 * This arm is consulted only where an Account intent can never exist: the
 * moment the Account holds any intent read for the plugin, that intent stays
 * the sole authority and app-package bytes can neither override nor revive it.
 */
function readHostBundledArtifactAdmission(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    slot: PluginAccountAvailabilityArtifactSlot,
): PluginAccountAvailabilityArtifactAdmission | null {
    if (!state) return null;
    const snapshot = readProjectionForScope(state, scope);
    if (!snapshot) return null;
    if (snapshot.intentReads.some((projection) => (
        projection.pluginId === slot.pluginId
        && projection.response.intent !== null
    ))) {
        return null;
    }
    const origin = slot.materializationOrigin;
    if (!origin || origin.materializationRef.pluginId !== slot.pluginId) return null;
    const materializations = snapshot.materializations.filter((materialization) => (
        materialization.serverIdentityId === origin.serverIdentityId
        && materialization.machineId === origin.materializationRef.machineId
        && materialization.materializationId === origin.materializationRef.materializationId
        && materialization.pluginId === origin.materializationRef.pluginId
        && materialization.sourceClass === 'bundledFirstParty'
        && materialization.enabled
        && materialization.trustState === 'trusted'
    ));
    if (materializations.length !== 1) return null;
    const materialization = materializations[0]!;
    const admittedSlots = materialization.uiArtifacts.filter((candidate) => (
        candidate.contributionId === slot.contributionId
        && candidate.tier === slot.tier
        && candidate.platform === slot.platform
    ));
    if (admittedSlots.length !== 1) return null;
    const admittedSlot = admittedSlots[0]!;
    const candidates = HOST_BUNDLED_PLUGIN_UI_ARTIFACTS.filter((candidate) => (
        candidate.pluginId === slot.pluginId
        && candidate.contributionId === slot.contributionId
        && candidate.tier === slot.tier
        && candidate.platform === slot.platform
        && candidate.releaseVersion === materialization.version
        && candidate.digest === admittedSlot.artifactDigest
    ));
    if (candidates.length === 0) return null;
    if (candidates.length !== 1) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_slot_ambiguous' });
    }
    const candidate = candidates[0]!;
    // No Account-hosted provenance is ever carried here: these bytes are in the
    // app package, and the Artifact lease remains the only integrity/graph owner.
    return Object.freeze({
        kind: 'available',
        availabilityCursor: snapshot.availabilityCursor,
        artifact: Object.freeze({
            pluginId: candidate.pluginId,
            contributionId: candidate.contributionId,
            tier: candidate.tier,
            platform: candidate.platform,
            digest: candidate.digest,
            releaseVersion: candidate.releaseVersion,
        }),
    });
}

type CurrentHostedSlotSelection =
    | Readonly<{
        kind: 'available';
        releaseSlot: PluginAccountAvailabilityReleaseUiSlot;
        /**
         * True only when the operator capability and the present Account
         * opt-in both admit Account hosting for this release.
         */
        accountHostedEnabled: boolean;
        exactHostedLink: PluginAccountAvailabilityIntentReadResponseV1['uiArtifacts'][number] | null;
    }>
    | Readonly<{
        kind: 'unavailable';
        code: 'artifact_not_current' | 'artifact_slot_ambiguous';
    }>;

/**
 * The single derivation of "which declared release slot does this coordinate
 * name, and does the Account already host its exact archive". Artifact
 * admission and hosted-publication admission are two readings of that one
 * fact; deriving it twice would let a reader and a publisher disagree about
 * whether a slot is already hosted.
 */
function selectCurrentHostedSlot(
    current: Extract<CurrentReleaseAdmission, { kind: 'available' }>,
    slot: PluginAccountAvailabilityArtifactSlot,
): CurrentHostedSlotSelection {
    const releaseSlots = current.release.uiSlots.filter((candidate) => (
        candidate.contributionId === slot.contributionId
        && candidate.tier === slot.tier
        && candidate.platform === slot.platform
    ));
    if (releaseSlots.length === 0) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_not_current' });
    }
    if (releaseSlots.length !== 1) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_slot_ambiguous' });
    }
    const releaseSlot = releaseSlots[0]!;
    const exactHostedLinks = current.uiArtifacts.filter((link) => (
        link.release.pluginId === current.release.ref.pluginId
        && link.release.version === current.release.ref.version
        && link.contributionId === releaseSlot.contributionId
        && link.tier === releaseSlot.tier
        && link.platform === releaseSlot.platform
        && link.artifactDigest === releaseSlot.artifactDigest
        && isPluginUiReleaseSlotCompatibleWithArtifactLinkV1(
            releaseSlot,
            link.compatibility,
        )
    ));
    // Availability owns the factual hosting capability and the Account intent
    // opt-in. A disabled/malformed capability must not admit Account-hosted
    // provenance, while the release identity remains available to the other
    // canonical Artifact sources.
    const accountHostedEnabled = current.hostingCapability.enabled === true
        && current.intent.offlineUiHosting === 'enabled';
    return Object.freeze({
        kind: 'available',
        releaseSlot,
        accountHostedEnabled,
        exactHostedLink: accountHostedEnabled && exactHostedLinks.length === 1
            ? exactHostedLinks[0]!
            : null,
    });
}

function readCurrentArtifactAdmission(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    slot: PluginAccountAvailabilityArtifactSlot,
): PluginAccountAvailabilityArtifactAdmission {
    const hostBundled = readHostBundledArtifactAdmission(state, scope, slot);
    if (hostBundled) return hostBundled;
    const current = readCurrentReleaseAdmission(state, scope, slot.pluginId);
    if (current.kind !== 'available') {
        return current;
    }
    if (!current.intent.enabled) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_not_current' });
    }
    const hosted = selectCurrentHostedSlot(current, slot);
    if (hosted.kind !== 'available') {
        return Object.freeze({ kind: 'unavailable', code: hosted.code });
    }
    const releaseSlot = hosted.releaseSlot;
    const selected: PluginAccountAvailabilitySelectedArtifactFact = Object.freeze({
        pluginId: slot.pluginId,
        contributionId: releaseSlot.contributionId,
        tier: releaseSlot.tier,
        platform: releaseSlot.platform,
        digest: releaseSlot.artifactDigest,
        releaseVersion: current.release.ref.version,
    });
    const exactHostedLink = hosted.exactHostedLink;
    const artifact: PluginAccountAvailabilityArtifactFact = exactHostedLink
        ? Object.freeze({
            ...selected,
            accountArtifactId: exactHostedLink.artifactId,
            accountArtifactCompatibility: exactHostedLink.compatibility,
        })
        : selected;
    return Object.freeze({
        kind: 'available',
        availabilityCursor: current.availabilityCursor,
        artifact: cloneArtifact(artifact),
    });
}

/**
 * Admits one exact declared slot for present-client Account-hosted
 * publication. It is deliberately not Artifact admission: it grants no byte
 * source and it is available only while the operator capability, the Account
 * opt-in, and the current release all admit hosting AND no exact qualified
 * link exists yet.
 */
function readCurrentHostedPublicationAdmission(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    slot: PluginAccountAvailabilityArtifactSlot,
): PluginAccountAvailabilityHostedPublicationAdmission {
    const current = readCurrentReleaseAdmission(state, scope, slot.pluginId);
    if (current.kind !== 'available') {
        return Object.freeze({ kind: 'unavailable', code: current.code });
    }
    if (!current.intent.enabled) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_not_current' });
    }
    const hosted = selectCurrentHostedSlot(current, slot);
    if (hosted.kind !== 'available') {
        return Object.freeze({ kind: 'unavailable', code: hosted.code });
    }
    if (!hosted.accountHostedEnabled) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_hosting_not_admitted' });
    }
    if (hosted.exactHostedLink) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_already_hosted' });
    }
    return Object.freeze({
        kind: 'available',
        availabilityCursor: current.availabilityCursor,
        target: freezeAvailabilitySnapshotValue({
            release: freezeAvailabilitySnapshotValue({ ...current.release.ref }),
            slot: freezeAvailabilitySnapshotValue({
                ...hosted.releaseSlot,
                compatibility: freezeAvailabilitySnapshotValue({
                    ...hosted.releaseSlot.compatibility,
                }),
            }),
        }),
    });
}

function clonePackageAssetDescriptor(
    descriptor: PackageAssetArchiveDescriptorV1,
): PluginAccountAvailabilityPackageAssetDescriptor {
    return Object.freeze({
        archiveDigestSha256: descriptor.archiveDigestSha256,
        resources: Object.freeze(descriptor.resources.map((resource) => Object.freeze({ ...resource }))),
    });
}

function readCurrentPackageAssetAdmission(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    input: Readonly<{ pluginId: string }>,
): PluginAccountAvailabilityPackageAssetAdmission {
    const current = readCurrentReleaseAdmission(state, scope, input.pluginId);
    if (current.kind !== 'available') return current;
    if (!current.intent.enabled) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_not_current' });
    }
    return Object.freeze({
        kind: 'available',
        availabilityCursor: current.availabilityCursor,
        packageAsset: Object.freeze({
            pluginId: input.pluginId,
            releaseVersion: current.release.ref.version,
            descriptor: clonePackageAssetDescriptor(current.release.packageAssetArchive),
        }),
    });
}

function readCurrentCollectionContractAdmission(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    input: Readonly<{ pluginId: string; collectionId: string }>,
): PluginAccountAvailabilityCollectionContractAdmission {
    const current = readCurrentReleaseAdmission(state, scope, input.pluginId);
    if (current.kind !== 'available') {
        return Object.freeze({ kind: 'unavailable', code: current.code });
    }
    if (!current.intent.enabled) {
        return Object.freeze({ kind: 'unavailable', code: 'collection_not_current' });
    }
    const candidates = current.release.collectionContracts.filter((candidate) => (
        candidate.pluginId === input.pluginId
        && candidate.collectionId === input.collectionId
    ));
    if (candidates.length === 0) {
        return Object.freeze({ kind: 'unavailable', code: 'collection_not_current' });
    }
    if (candidates.length !== 1) {
        return Object.freeze({ kind: 'unavailable', code: 'collection_slot_ambiguous' });
    }
    return Object.freeze({
        kind: 'available',
        availabilityCursor: current.availabilityCursor,
        ref: Object.freeze({ ...candidates[0]! }),
    });
}

function readCurrentCollectionCapabilityAdmission(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    input: Readonly<{ pluginId: string }>,
): PluginAccountAvailabilityCollectionCapabilityAdmission {
    const current = readCurrentReleaseAdmission(state, scope, input.pluginId);
    if (current.kind !== 'available') {
        return Object.freeze({ kind: 'unavailable', code: current.code });
    }
    if (!current.intent.enabled || current.release.collectionContracts.length === 0) {
        return Object.freeze({ kind: 'unavailable', code: 'collection_not_current' });
    }
    return Object.freeze({
        kind: 'available',
        availabilityCursor: current.availabilityCursor,
    });
}

function readCurrentSettingsDeclarationAdmission(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    input: Readonly<{ pluginId: string }>,
): PluginAccountAvailabilitySettingsDeclarationAdmission {
    const current = readCurrentReleaseAdmission(state, scope, input.pluginId);
    if (current.kind !== 'available') {
        return Object.freeze({ kind: 'unavailable', code: current.code });
    }
    return Object.freeze({
        kind: 'available',
        availabilityCursor: current.availabilityCursor,
        declaration: current.release.normalizedManifest,
    });
}

function createBoundReader(input: Readonly<{
    scope: ServerAccountScope;
    readState: () => AvailabilityProjectionState | null;
    subscribe: (listener: () => void) => () => void;
}>): PluginAccountAvailabilityReader {
    return Object.freeze({
        readCurrentArtifact: (slot) => readCurrentArtifactAdmission(
            input.readState(),
            input.scope,
            slot,
        ),
        readCurrentHostedPublicationTarget: (slot) => readCurrentHostedPublicationAdmission(
            input.readState(),
            input.scope,
            slot,
        ),
        readCurrentPackageAsset: (packageAsset) => readCurrentPackageAssetAdmission(
            input.readState(),
            input.scope,
            packageAsset,
        ),
        readCurrentCollectionContract: (collection) => readCurrentCollectionContractAdmission(
            input.readState(),
            input.scope,
            collection,
        ),
        readCurrentCollectionCapability: (plugin) => readCurrentCollectionCapabilityAdmission(
            input.readState(),
            input.scope,
            plugin,
        ),
        readCurrentSettingsDeclaration: (settings) => readCurrentSettingsDeclarationAdmission(
            input.readState(),
            input.scope,
            settings,
        ),
        readCurrentReleaseSelection: (selection) => readCurrentReleaseSelectionAdmission(
            input.readState(),
            input.scope,
            selection,
        ),
        classifyRelease: (materialization) => classifyMaterializationRelease(
            input.readState(),
            input.scope,
            materialization,
        ),
        readMaterializations: () => readMaterializationAdmission(input.readState(), input.scope),
        subscribe: input.subscribe,
    });
}

/**
 * A fixed Account/realm projection reader for currentness/materialization
 * facts. Byte materialization and renderer containment remain with their
 * concrete producers; this reader has no URL or cache-source selection path.
 */
export function createPluginAccountAvailabilityReader(input: Readonly<{
    scope: ServerAccountScope;
    snapshot: PluginAccountAvailabilitySnapshot;
}>): PluginAccountAvailabilityReader {
    const state: AvailabilityProjectionState = Object.freeze({
        scope: Object.freeze({ ...input.scope }),
        snapshot: snapshotPluginAccountAvailabilitySnapshot(input.snapshot),
    });
    return createBoundReader({
        scope: state.scope,
        readState: () => state,
        subscribe: () => () => {},
    });
}

/**
 * The live Account projection owner. Account-change consumers replace one
 * complete materialization snapshot; no renderer-specific selector is kept.
 */
export function createPluginAccountAvailabilityReaderStore(): PluginAccountAvailabilityReaderStore {
    let state: AvailabilityProjectionState | null = null;
    const listeners = new Set<() => void>();
    const notify = () => {
        for (const listener of listeners) listener();
    };
    const subscribe = (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
    };
    return Object.freeze({
        replace: (input) => {
            const previous = state;
            state = Object.freeze({
                scope: Object.freeze({ ...input.scope }),
                snapshot: snapshotPluginAccountAvailabilitySnapshot(input.snapshot),
            });
            notify();
            return previous;
        },
        clear: () => {
            const previous = state;
            state = null;
            notify();
            return previous;
        },
        subscribe,
        bind: (scope) => createBoundReader({
            scope: Object.freeze({ ...scope }),
            readState: () => state,
            subscribe,
        }),
    });
}
