import type {
    PackageAssetArchiveDescriptorV1,
    PluginAccountAvailabilityIntentReadResponseV1,
    PluginMachineMaterializationSnapshotV1,
    PluginMachineMaterializationV1,
    PluginMachineMaterializationRefV1,
    PluginPortableReleaseManifestV1,
    PluginReleaseFactsV1,
} from '@happier-dev/protocol/plugins/availability';
import {
    isExactPluginMachineMaterializationReleaseCorrespondenceV1,
    isPluginUiReleaseSlotCompatibleWithArtifactLinkV1,
    snapshotPluginReleaseFactsV1,
    PluginPortableReleaseManifestV1Schema,
    resolvePluginAccountExecutionSelectionV1,
    createPluginAccountBundledSelectionV1,
    type PluginAccountExecutionSelectionV1,
} from '@happier-dev/protocol/plugins/availability';
import { PluginUiArtifactsManifestEntryV2Schema, isPluginUiHostApiVersionCompatibleWithVersionV1, PLUGIN_UI_HOST_API_VERSION_V1,
    type PluginUiArtifactsManifestEntryV2, type PluginUiArtifactDigestV1 } from '@happier-dev/protocol/plugins/ui';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { projectPluginReactNativeArtifactEntryV1 } from '@happier-dev/protocol/plugins/contributions/ui';
import type { PluginCollectionContractRefV1 } from '@happier-dev/protocol';
import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { PluginDeclaredUiEntriesV1Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { projectPluginPortableUiDeclarationsV1 } from '@happier-dev/protocol/plugins/contributions/ui';
import { preparePluginContributionPointDeclarationsV1 } from '@happier-dev/protocol/plugins/contributions/targeted';
import { samePluginUiMaterializationFacts, normalizePluginInstalledUiDeclarations, type PluginUiActionProjection, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { preparePluginUiProjectionOrigins } from '@/sync/domains/plugins/ui/projectionOrigins';
import { projectPluginRegistrySourceDeclarationV1 } from '@happier-dev/protocol/registries';
import { projectPluginSkillDeclarationV1 } from '@happier-dev/protocol/plugins/contributions/skills';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { derivePluginReactNativeBundleCacheKey } from '@/components/plugins/reactNative/bundleCache';

import {
    areServerAccountScopesEqual,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import type { PluginHostBundledUiDeclaration } from './bundledPluginUiArtifactInventory';
export type { PluginHostBundledUiDeclaration } from './bundledPluginUiArtifactInventory';

export type PluginAccountExecutionAdmission = PluginAccountExecutionSelectionV1 | Readonly<{
    kind: 'unavailable';
    code: 'account_availability_not_loaded' | 'account_availability_scope_mismatch';
}>;

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
    /** False means omitted machines are unknown, rather than uninstalled. */
    inventoryComplete?: boolean;
    /** Exact immutable installed release facts, not enabled selection intent. */
    releases?: readonly PluginReleaseFactsV1[];
}>;

export type PluginAccountInstalledPluginInstallation = Readonly<{
    materialization: PluginMachineMaterializationV1;
    declaration: PluginPortableReleaseManifestV1 | null;
    declarationState: 'known' | 'preparing';
    /** Manifest knowledge alone does not prove projected renderer descriptors. */
    uiDeclarationState: 'known' | 'preparing';
    release: PluginReleaseFactsV1 | null;
    execution: PluginAccountAvailabilityReleaseClassificationV1;
    uiModel: PluginUiProjectionModel;
}>;

export type PluginAccountInstalledPluginsAdmission =
    | Readonly<{
        kind: 'available';
        availabilityCursor: number;
        completeness: 'complete' | 'incomplete';
        plugins: readonly Readonly<{ pluginId: string; installations: readonly PluginAccountInstalledPluginInstallation[] }>[];
    }>
    | Extract<PluginMachineMaterializationAdmission, { kind: 'unavailable' }>;

export type PluginAccountAvailabilityIntentReadProjection = Readonly<{
    pluginId: string;
    response: PluginAccountAvailabilityIntentReadResponseV1;
}>;

export type PluginAccountAvailabilityArtifactSlot = Readonly<{
    pluginId: string;
    contributionId: string;
    tier: 'declarative' | 'hostedWeb' | 'reactNative';
    platform: 'web' | 'ios' | 'android';
}>;

/** Immutable release-selected bytes facts, independent of any source link. */
export type PluginAccountAvailabilitySelectedArtifactFact = PluginAccountAvailabilityArtifactSlot & Readonly<{
    artifactId: string;
    digest: PluginUiArtifactDigestV1;
    hostUiApiRange: string;
    releaseVersion: string;
}>;

/** Source-local Account-hosted link provenance; never a selected-byte identity. */
export type PluginAccountAvailabilityArtifactSourceFact =
    | Readonly<{
        accountArtifactId?: never;
    }>
    | Readonly<{
        accountArtifactId: string;
    }>;

export type PluginAccountAvailabilityArtifactFact = PluginAccountAvailabilitySelectedArtifactFact
    & PluginAccountAvailabilityArtifactSourceFact;

/**
 * Exact non-portable Artifact selected by an admitted daemon projection.
 * Account disable and portable release intent retain precedence; the source
 * supplies its own occurrence currentness, never Account authority.
 */
export type PluginDaemonProjectionArtifactSelection = Readonly<{
    occurrenceId: string;
    artifact: PluginAccountAvailabilityArtifactFact;
    isCurrent: () => boolean;
}>;

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
            reason: 'disabled' | 'plugin_mismatch' | 'release_unavailable' | 'non_portable';
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
        /** Existing Account projection truth consumed by Administration. */
        intentReads: readonly PluginAccountAvailabilityIntentReadProjection[];
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

export type PluginAccountAvailabilityHostedPackageAssetPublicationAdmission =
    | Readonly<{
        kind: 'available';
        availabilityCursor: number;
        target: Readonly<{
            release: NonNullable<PluginAccountAvailabilityIntentReadResponseV1['release']>['ref'];
            normalizedManifest: PluginPortableReleaseManifestV1;
            descriptor: PackageAssetArchiveDescriptorV1;
        }>;
    }>
    | Extract<PluginAccountAvailabilityHostedPublicationAdmission, { kind: 'unavailable' }>;

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
 * whether the enabled release admits direct Account Data through an exact
 * Collection contract or required Account-KV access; callers receive neither
 * declarations nor mutation authority. Exact contract selection and CAS
 * remain with the Data owner.
 */
export type PluginAccountAvailabilityDataCapabilityAdmission =
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
            | 'account_data_not_current';
    }>;

/**
 * Current admission for the Account KV operation surface. A selected release
 * admits KV only through its explicit required `storage.account` declaration
 * (its Collection contracts do not satisfy it); a release-less daemon claim
 * admits the claiming plugin's own KV.
 */
export type PluginAccountAvailabilityAccountKvAdmission =
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
            | 'account_kv_not_current';
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

export type PluginAccountAvailabilityHostedArtifactAdministrationAdmission =
    | Readonly<{
        kind: 'available';
        availabilityCursor: number;
        hostingCapability: PluginAccountAvailabilityIntentReadResponseV1['hostingCapability'];
        intent: NonNullable<PluginAccountAvailabilityIntentReadResponseV1['intent']>;
        release: Readonly<{
            ref: NonNullable<PluginAccountAvailabilityIntentReadResponseV1['release']>['ref'];
            uiSlots: NonNullable<PluginAccountAvailabilityIntentReadResponseV1['release']>['uiSlots'];
            packageAssetArchive: PackageAssetArchiveDescriptorV1;
        }>;
        uiArtifacts: PluginAccountAvailabilityIntentReadResponseV1['uiArtifacts'];
        packageAssets: PluginAccountAvailabilityIntentReadResponseV1['packageAssets'];
    }>
    | Readonly<{
        kind: 'unavailable';
        code: 'account_availability_not_loaded' | 'account_availability_scope_mismatch' | 'artifact_not_current' | 'artifact_slot_ambiguous';
    }>;

export type PluginAccountAvailabilityReader = Readonly<{
    /** Opaque current publication identity, scoped to this reader's Account. */
    getObservationSnapshot: (pluginId?: string) => object | null;
    /** Stable descriptive UI inputs; invocation authority remains a live read below. */
    readUiProjectionInputs: () => PluginAccountUiProjectionInputs | null;
    /** Account custody projects into the existing executable registration owner. */
    readAccountUiProjection: () => PluginUiProjectionModel | null;
    readCurrentAccountExecution: (pluginId: string) => PluginAccountExecutionAdmission;
    /** Current enabled declarations, including descriptive Machine-placed sources. */
    readCurrentAccountExecutionDeclarations: () => readonly Extract<PluginAccountExecutionSelectionV1, { kind: 'available' }>[];
    /**
     * Current expected Artifact identity only. This is intentionally not a
     * byte-source selector: URLs, cache state, source priority, and transport
     * remain private to the Artifact adoption/cache owner.
     * An exact installed origin can admit its census release when the Account
     * explicitly has no selection; it never selects a global release.
     */
    readCurrentArtifact: (
        slot: PluginAccountAvailabilityArtifactSlot,
        executionOrigin?: PluginMachineExecutionOriginV1 | null,
        daemonProjectionSelection?: PluginDaemonProjectionArtifactSelection,
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
    /** Same hosting intent, for the selected release's declared packaged assets. */
    readCurrentHostedPackageAssetPublicationTarget: (input: Readonly<{
        pluginId: string;
    }>) => PluginAccountAvailabilityHostedPackageAssetPublicationAdmission;
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
        /** Exact retained ref requested by an already-mounted release. */
        ref?: PluginCollectionContractRefV1;
    }>) => PluginAccountAvailabilityCollectionContractAdmission;
    /**
     * Current enabled-release capability for direct Account Data UI. This is
     * intentionally an opaque presence fact, not a reconstructed declaration,
     * contract inventory, or mutation authorization.
     */
    readCurrentAccountDataCapability: (input: Readonly<{
        pluginId: string;
    }>) => PluginAccountAvailabilityDataCapabilityAdmission;
    /**
     * Current enabled-release admission for Account KV operations. This is
     * re-read for every operation and conveys no Collection authority.
     */
    readCurrentAccountKvCapability: (input: Readonly<{
        pluginId: string;
    }>) => PluginAccountAvailabilityAccountKvAdmission;
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
    /** Current exact facts for the existing plugin-detail hosted Artifact controller. */
    readCurrentHostedArtifactAdministration: (input: Readonly<{
        pluginId: string;
    }>) => PluginAccountAvailabilityHostedArtifactAdministrationAdmission;
    /**
     * Validates immutable Account release facts against a materialization's
     * explicit correspondence/status. It cannot select a machine or infer
     * transport/source authority.
     */
    classifyRelease: (
        materialization: PluginMachineMaterializationV1,
    ) => PluginAccountAvailabilityReleaseClassificationV1;
    readMaterializations: () => PluginMachineMaterializationAdmission;
    /** Descriptive installation census, independent of enabled Account intent. */
    readInstalledPlugins: () => PluginAccountInstalledPluginsAdmission;
    /**
     * A lifecycle signal only. Consumers re-read through this owner; they
     * never receive a raw snapshot or a second currentness owner.
     */
    subscribe: (listener: () => void) => () => void;
}>;

/** Cursor-free declaration inputs. Observation time is not a declaration revision. */
export type PluginAccountUiProjectionInputs = Readonly<{
    materializations: readonly PluginMachineMaterializationV1[];
    installedPlugins: Extract<PluginAccountInstalledPluginsAdmission, { kind: 'available' }>['plugins'] | undefined;
    accountUiProjection: PluginUiProjectionModel | null;
}>;

export type PluginAccountAvailabilityReaderStore = Readonly<{
    replace: (input: Readonly<{
        scope: ServerAccountScope;
        snapshot: PluginAccountAvailabilitySnapshot;
        failedPluginIds?: readonly string[];
        intentCensusIncomplete?: boolean;
    }>) => PluginAccountAvailabilityStoredProjection | null;
    clear: () => PluginAccountAvailabilityStoredProjection | null;
    /**
     * Explicit withdrawal (local disable/uninstall/revoke): removes the named
     * plugins' release facts so their mounted authority retires immediately.
     * A failed refresh is not withdrawal; it only flags the plugin stale.
     */
    retire: (pluginIds: readonly string[]) => void;
    /** Stable immutable snapshot for the projection owner's React subscription. */
    getSnapshot: () => PluginAccountAvailabilityStoredProjection | null;
    /** Stable opaque observation slices, prepared before publication notification. */
    getObservationSnapshot: (pluginId?: string) => object | null;
    subscribe: (listener: () => void) => () => void;
    /**
     * Binds a caller to one Account/realm without disclosing that scope to a
     * renderer. If this store moves to another Account, the retained reader is
     * typed unavailable instead of reading the new Account's projection.
     */
    bind: (scope: ServerAccountScope) => PluginAccountAvailabilityReader;
}>;

/**
 * The immutable projection exposed only to its lifecycle/React owner. Readers
 * still expose facts, not raw Availability snapshots, to their consumers.
 */
export type PluginAccountAvailabilityStoredProjection = Readonly<{
    scope: ServerAccountScope;
    snapshot: PluginAccountAvailabilitySnapshot;
    /**
     * Plugins whose last refresh failed. Their last-confirmed facts remain
     * readable and current (AVD-07); this is refresh status only.
     */
    stalePluginIds: readonly string[];
    retiredPluginIds?: readonly string[];
}>;

type AvailabilityProjectionState = PluginAccountAvailabilityStoredProjection & Readonly<{
    materializationsByIdentity: ReadonlyMap<string, readonly PluginMachineMaterializationV1[]>;
    intentReadsByPluginId: ReadonlyMap<string, readonly PluginAccountAvailabilityIntentReadProjection[]>;
    bundledUiByPluginId: ReadonlyMap<string, readonly PreparedBundledUiDeclaration[]>;
}>;

function materializationLookupKey(input: Pick<PluginMachineMaterializationV1,
    'pluginId' | 'serverIdentityId' | 'machineId' | 'materializationId'>): string {
    return JSON.stringify([input.pluginId, input.serverIdentityId, input.machineId, input.materializationId]);
}

function indexMaterializations(snapshot: PluginAccountAvailabilitySnapshot): AvailabilityProjectionState['materializationsByIdentity'] {
    return indexAvailabilityRows(snapshot.materializations, materializationLookupKey);
}

function indexAvailabilityRows<T>(rows: readonly T[], keyOf: (row: T) => string): ReadonlyMap<string, readonly T[]> {
    const indexed = new Map<string, T[]>();
    for (const row of rows) {
        const key = keyOf(row);
        const values = indexed.get(key);
        if (values) values.push(row);
        else indexed.set(key, [row]);
    }
    for (const values of indexed.values()) Object.freeze(values);
    return indexed;
}

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
    previous?: PluginMachineMaterializationV1,
): PluginMachineMaterializationV1 {
    return freezeAvailabilitySnapshotValue({
        ...materialization,
        ...(materialization.declaredManifest ? {
            declaredManifest: retainUnchangedAvailabilityValue(previous?.declaredManifest,
                freezeDeepDeclaration(PluginPortableReleaseManifestV1Schema.parse(materialization.declaredManifest))),
        } : {}),
        ...(materialization.declaredUiEntries ? {
            declaredUiEntries: retainUnchangedAvailabilityValue(previous?.declaredUiEntries,
                freezeDeepDeclaration(PluginDeclaredUiEntriesV1Schema.parse(materialization.declaredUiEntries))),
        } : {}),
        uiArtifacts: retainUnchangedAvailabilityValue(previous?.uiArtifacts, freezeAvailabilitySnapshotValue(materialization.uiArtifacts.map((artifact) => (
            freezeAvailabilitySnapshotValue({ ...artifact })
        )))),
    });
}

function freezeDeepDeclaration<T>(value: T): T {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freezeDeepDeclaration(child);
        Object.freeze(value);
    }
    return value;
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
        release: response.release ? snapshotPluginReleaseFactsV1(response.release) : null,
        packageAssets: freezeAvailabilitySnapshotValue(response.packageAssets.map((artifact) => (
            freezeAvailabilitySnapshotValue({
                ...artifact,
                release: freezeAvailabilitySnapshotValue({ ...artifact.release }),
                descriptor: clonePackageAssetDescriptor(artifact.descriptor),
            })
        ))),
        uiArtifacts: freezeAvailabilitySnapshotValue(response.uiArtifacts.map((artifact) => (
            freezeAvailabilitySnapshotValue({
                ...artifact,
                release: freezeAvailabilitySnapshotValue({ ...artifact.release }),
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
    previous?: PluginAccountAvailabilitySnapshot,
): PluginAccountAvailabilitySnapshot {
    const previousMaterializations = new Map(previous?.materializations.map(row => [materializationLookupKey(row), row] as const));
    const clone = (row: PluginMachineMaterializationV1) => cloneMaterialization(row, previousMaterializations.get(materializationLookupKey(row)));
    return freezeAvailabilitySnapshotValue({
        availabilityCursor: snapshot.availabilityCursor,
        inventoryComplete: snapshot.inventoryComplete !== false,
        releases: Object.freeze((snapshot.releases ?? []).map(snapshotPluginReleaseFactsV1)),
        intentReads: freezeAvailabilitySnapshotValue(snapshot.intentReads.map((projection) => (
            freezeAvailabilitySnapshotValue({
                pluginId: projection.pluginId,
                response: snapshotIntentReadResponse(projection.response),
            })
        ))),
        materializations: freezeAvailabilitySnapshotValue(snapshot.materializations.map(clone)),
        snapshots: freezeAvailabilitySnapshotValue(snapshot.snapshots.map((machineSnapshot) => (
            freezeAvailabilitySnapshotValue({
                ...machineSnapshot,
                materializations: freezeAvailabilitySnapshotValue(
                    machineSnapshot.materializations.map(clone),
                ),
            })
        ))),
    });
}

/** These owned Protocol facts are JSON values; equality retains data, never current admission. */
function retainUnchangedAvailabilityValue<T>(previous: T | undefined, next: T): T {
    return previous !== undefined && sameStrictJsonValue(previous, next) ? previous : next;
}

/** Local edits to the ordered snapshot retain the unchanged rows beside them. */
function retainUnchangedAvailabilityRows<T>(previous: readonly T[] | undefined, next: readonly T[]): readonly T[] {
    if (!previous) return next;
    const rows = next.map((row, index) => retainUnchangedAvailabilityValue(previous[index], row));
    return previous.length === rows.length && rows.every((row, index) => row === previous[index])
        ? previous : Object.freeze(rows);
}

function cloneArtifact(artifact: PluginAccountAvailabilityArtifactFact): PluginAccountAvailabilityArtifactFact {
    const selected: PluginAccountAvailabilitySelectedArtifactFact = freezeAvailabilitySnapshotValue({
        pluginId: artifact.pluginId,
        contributionId: artifact.contributionId,
        artifactId: artifact.artifactId,
        tier: artifact.tier,
        platform: artifact.platform,
        digest: artifact.digest,
        hostUiApiRange: artifact.hostUiApiRange,
        releaseVersion: artifact.releaseVersion,
    });
    if (!artifact.accountArtifactId) {
        return selected;
    }
    return freezeAvailabilitySnapshotValue({
        ...selected,
        accountArtifactId: artifact.accountArtifactId,
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
        // Administration consumes the same Account intent/release responses,
        // but receives only links qualified by Availability's canonical exact
        // slot matcher. Presentation must not reinterpret raw link counts as
        // exact hosted availability.
        intentReads: Object.freeze(snapshot.intentReads
            .map((projection) => {
                const hosted = readCurrentHostedArtifactAdministrationAdmission(
                    state,
                    scope,
                    { pluginId: projection.pluginId },
                );
                return Object.freeze({
                    pluginId: projection.pluginId,
                    response: Object.freeze({
                        ...projection.response,
                        uiArtifacts: hosted.kind === 'available'
                            ? hosted.uiArtifacts
                            : Object.freeze([]),
                        packageAssets: hosted.kind === 'available'
                            ? hosted.packageAssets
                            : Object.freeze([]),
                    }),
                });
            })),
        // Ingestion already validates, copies and freezes this inventory.
        // Reuse those owned facts until the Account projection replaces them.
        materializations: snapshot.materializations,
        snapshots: snapshot.snapshots,
    });
}

function readInstalledPluginsAdmission(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    previous?: PluginAccountInstalledPluginsAdmission,
): PluginAccountInstalledPluginsAdmission {
    const admitted = readMaterializationAdmission(state, scope);
    if (admitted.kind === 'unavailable') return admitted;
    const snapshot = readProjectionForScope(state, scope)!;
    const previousInstallations = new Map(previous?.kind === 'available' ? previous.plugins.flatMap(plugin =>
        plugin.installations.map(installation => [materializationLookupKey(installation.materialization), installation] as const)) : []);
    const previousPlugins = new Map(previous?.kind === 'available' ? previous.plugins.map(plugin => [plugin.pluginId, plugin] as const) : []);
    const byPluginId = new Map<string, PluginAccountInstalledPluginInstallation[]>();
    for (const materialization of admitted.materializations) {
        const releases = [...(snapshot.releases ?? []), ...snapshot.intentReads.flatMap((entry) => {
            const release = entry.pluginId === materialization.pluginId ? entry.response.release : null;
            return release ? [release] : [];
        })].filter(release => isExactPluginMachineMaterializationReleaseCorrespondenceV1(materialization, release));
        const uniqueReleases = new Map(releases.map(release => [release.archiveDigestSha256, release]));
        const release = uniqueReleases.size === 1 ? [...uniqueReleases.values()][0]! : null;
        const declaration = release?.normalizedManifest ?? materialization.declaredManifest ?? null;
        const installations = byPluginId.get(materialization.pluginId) ?? [];
        const incumbent = previousInstallations.get(materializationLookupKey(materialization));
        let uiModel = incumbent && samePluginUiMaterializationFacts(incumbent.materialization, materialization) && incumbent.declaration === declaration
            && incumbent.release === release ? incumbent.uiModel : undefined;
        if (!uiModel) {
            const declaredUiEntries = materialization.declaredUiEntries
                ?? (release ? projectPluginPortableUiDeclarationsV1(release.normalizedManifest) : undefined);
            const registrySources = declaration ? (declaration.contributes?.registrySources ?? []).map(definition =>
                projectPluginRegistrySourceDeclarationV1({ pluginId: materialization.pluginId,
                    pluginVersion: declaration.version, definition })) : [];
            const skills = declaration ? (declaration.contributes?.skills ?? []).map(definition =>
                projectPluginSkillDeclarationV1({ pluginId: materialization.pluginId,
                    pluginVersion: declaration.version, definition })) : [];
            uiModel = normalizePluginInstalledUiDeclarations(declaredUiEntries ?? {}, undefined, {
                id: materialization.pluginId,
                displayName: typeof declaration?.displayName === 'string'
                    ? declaration.displayName : declaration?.displayName.fallback ?? materialization.pluginId,
                version: materialization.version,
                enabled: materialization.enabled,
                source: { kind: materialization.sourceClass, locator: materialization.materializationId },
                ...(declaration?.executionTarget ? { executionTarget: declaration.executionTarget } : {}),
                ...(declaration ? { declaredExecution: {
                    daemonActions: declaration.contributes.actions?.some(action => action.execution?.target !== 'client') === true,
                    contributionPoints: (declaration.contributes.pluginContributionPoints?.length ?? 0) > 0,
                } } : {}),
            }, registrySources, skills);
            uiModel = preparePluginUiProjectionOrigins(uiModel);
        }
        installations.push(retainUnchangedAvailabilityValue(incumbent, Object.freeze({
            materialization,
            declaration,
            declarationState: declaration ? 'known' : 'preparing',
            uiDeclarationState: materialization.declaredUiEntries !== undefined || release ? 'known' : 'preparing',
            release,
            execution: classifyMaterializationRelease(state, scope, materialization),
            uiModel,
        })));
        byPluginId.set(materialization.pluginId, installations);
    }
    return retainUnchangedAvailabilityValue(previous, Object.freeze({
        kind: 'available',
        availabilityCursor: snapshot.availabilityCursor,
        completeness: snapshot.inventoryComplete === false ? 'incomplete' : 'complete',
        plugins: Object.freeze([...byPluginId].sort(([a], [b]) => a.localeCompare(b)).map(([pluginId, installations]) => retainUnchangedAvailabilityValue(previousPlugins.get(pluginId), Object.freeze({
            pluginId,
            installations: Object.freeze(installations),
        })))),
    }));
}

type CurrentReleaseAdmission =
    | Readonly<{
        kind: 'available';
        availabilityCursor: number;
        hostingCapability: PluginAccountAvailabilityIntentReadResponseV1['hostingCapability'];
        intent: NonNullable<PluginAccountAvailabilityIntentReadResponseV1['intent']>;
        release: NonNullable<PluginAccountAvailabilityIntentReadResponseV1['release']>;
        uiArtifacts: PluginAccountAvailabilityIntentReadResponseV1['uiArtifacts'];
        packageAssets: PluginAccountAvailabilityIntentReadResponseV1['packageAssets'];
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
    const projections = state.intentReadsByPluginId.get(pluginId) ?? [];
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
        !intent
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
        availabilityCursor: response.availabilityCursor,
        hostingCapability: response.hostingCapability,
        intent,
        release,
        uiArtifacts: response.uiArtifacts,
        packageAssets: response.packageAssets,
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

function readCurrentHostedArtifactAdministrationAdmission(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    input: Readonly<{ pluginId: string }>,
): PluginAccountAvailabilityHostedArtifactAdministrationAdmission {
    const current = readCurrentReleaseAdmission(state, scope, input.pluginId);
    if (current.kind !== 'available') return current;
    const uiArtifacts = current.release.uiSlots.flatMap((slot) => {
        const exact = selectExactHostedLinks(current, slot);
        return exact.length === 1 ? [exact[0]!] : [];
    });
    const packageAssets = selectExactHostedPackageAssetLinks(current);
    return Object.freeze({
        kind: 'available',
        availabilityCursor: current.availabilityCursor,
        hostingCapability: current.hostingCapability,
        intent: cloneSelectionIntent(current.intent),
        release: Object.freeze({
            ref: Object.freeze({ ...current.release.ref }),
            uiSlots: current.release.uiSlots,
            packageAssetArchive: current.release.packageAssetArchive,
        }),
        uiArtifacts: Object.freeze(uiArtifacts),
        packageAssets: Object.freeze(packageAssets.length === 1 ? packageAssets : []),
    });
}

/** Exact installed custody may admit local UI bytes, never Account intent or hosted publication. */
function readInstalledReleaseAdmission(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    pluginId: string,
    origin: PluginMachineExecutionOriginV1 | null | undefined,
): Readonly<{ availabilityCursor: number; release: PluginReleaseFactsV1 }> | null {
    const snapshot = readProjectionForScope(state, scope);
    if (!snapshot || !origin || !('materializationRef' in origin)
        || origin.materializationRef.pluginId !== pluginId || state?.retiredPluginIds?.includes(pluginId)) return null;
    const intents = state!.intentReadsByPluginId.get(pluginId) ?? [];
    // An explicit null read proves absence; missing or competing reads do not.
    if (intents.length !== 1 || intents[0]!.response.intent !== null) return null;
    const rows = state!.materializationsByIdentity.get(materializationLookupKey({
        ...origin.materializationRef, serverIdentityId: origin.serverIdentityId,
    })) ?? [];
    if (rows.length !== 1) return null;
    const materialization = rows[0]!;
    if (!materialization.enabled || materialization.trustState !== 'trusted' || !materialization.portableRelease) return null;
    const releases = (snapshot.releases ?? []).filter(release =>
        isExactPluginMachineMaterializationReleaseCorrespondenceV1(materialization, release));
    if (releases.length !== 1) return null;
    return Object.freeze({ availabilityCursor: snapshot.availabilityCursor, release: releases[0]! });
}

function classifyMaterializationRelease(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    materialization: PluginMachineMaterializationV1,
): PluginAccountAvailabilityReleaseClassificationV1 {
    const identity = projectPluginAccountAvailabilityMaterializationIdentity(materialization);
    if (!materialization.portableRelease) {
        return Object.freeze({ ...identity, releaseContent: 'unknown',
            validation: Object.freeze({ kind: 'rejected', reason: 'non_portable' }) });
    }
    const current = readCurrentReleaseAdmission(state, scope, materialization.pluginId);
    if (current.kind !== 'available') {
        const installed = readInstalledReleaseAdmission(state, scope, materialization.pluginId, identity);
        if (installed && isExactPluginMachineMaterializationReleaseCorrespondenceV1(materialization, installed.release)) {
            return Object.freeze({ ...identity, releaseContent: 'matched', validation: Object.freeze({ kind: 'admitted' }) });
        }
        return Object.freeze({
            ...identity,
            releaseContent: 'unknown',
            validation: Object.freeze({ kind: 'rejected', reason: 'release_unavailable' }),
        });
    }
    if (materialization.pluginId !== current.intent.pluginId) {
        return Object.freeze({
            ...identity,
            releaseContent: 'unknown',
            validation: Object.freeze({ kind: 'rejected', reason: 'plugin_mismatch' }),
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
    const selected = selectReleaseSlot(current.release, slot);
    if (selected.kind !== 'available') return selected;
    const releaseSlot = selected.releaseSlot;
    const exactHostedLinks = selectExactHostedLinks(current, releaseSlot);
    // Hosting continues to require Account intent even for an installed renderer.
    const accountHostedEnabled = isAccountArtifactHostingAdmitted(current);
    return Object.freeze({
        kind: 'available', releaseSlot, accountHostedEnabled,
        exactHostedLink: accountHostedEnabled && exactHostedLinks.length === 1 ? exactHostedLinks[0]! : null,
    });
}

function selectReleaseSlot(
    release: PluginReleaseFactsV1,
    slot: PluginAccountAvailabilityArtifactSlot,
): Readonly<{ kind: 'available'; releaseSlot: PluginAccountAvailabilityReleaseUiSlot }>
    | Readonly<{ kind: 'unavailable'; code: 'artifact_not_current' | 'artifact_slot_ambiguous' }> {
    const releaseSlots = release.uiSlots.filter((candidate) => (
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
    return Object.freeze({ kind: 'available', releaseSlot: releaseSlots[0]! });
}

function selectExactHostedLinks(
    current: Extract<CurrentReleaseAdmission, { kind: 'available' }>,
    releaseSlot: PluginAccountAvailabilityReleaseUiSlot,
) {
    return current.uiArtifacts.filter((link) => (
        link.release.pluginId === current.release.ref.pluginId
        && link.release.version === current.release.ref.version
        && link.contributionId === releaseSlot.contributionId
        && link.tier === releaseSlot.tier
        && link.platform === releaseSlot.platform
        && link.artifactDigest === releaseSlot.artifactDigest
        && isPluginUiReleaseSlotCompatibleWithArtifactLinkV1(
            releaseSlot,
            link,
        )
    ));
}

function readCurrentArtifactAdmission(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    slot: PluginAccountAvailabilityArtifactSlot,
    hostBundledUi: readonly PreparedBundledUiDeclaration[] = [],
    executionOrigin?: PluginMachineExecutionOriginV1 | null,
    daemonProjectionSelection?: PluginDaemonProjectionArtifactSelection,
): PluginAccountAvailabilityArtifactAdmission {
    const current = readCurrentReleaseAdmission(state, scope, slot.pluginId);
    if (current.kind !== 'available') {
        if (daemonProjectionSelection) {
            const snapshot = readCurrentNonPortableUiSnapshot(state, scope, slot.pluginId);
            if (!snapshot) return current;
            const selected = daemonProjectionSelection;
            if (!selected.occurrenceId.trim()
                || selected.artifact.pluginId !== slot.pluginId
                || selected.artifact.contributionId !== slot.contributionId
                || selected.artifact.tier !== slot.tier
                || selected.artifact.platform !== slot.platform) {
                return Object.freeze({ kind: 'unavailable', code: 'artifact_not_current' });
            }
            try {
                if (!selected.isCurrent()) return Object.freeze({ kind: 'unavailable', code: 'artifact_not_current' });
            } catch {
                return Object.freeze({ kind: 'unavailable', code: 'artifact_not_current' });
            }
            return Object.freeze({ kind: 'available', availabilityCursor: snapshot.availabilityCursor,
                artifact: cloneArtifact(selected.artifact) });
        }
        const installed = readInstalledReleaseAdmission(state, scope, slot.pluginId, executionOrigin);
        if (installed) {
            const selected = selectReleaseSlot(installed.release, slot);
            if (selected.kind !== 'available') return selected;
            const artifact = selected.releaseSlot;
            return Object.freeze({ kind: 'available', availabilityCursor: installed.availabilityCursor,
                artifact: Object.freeze({ ...slot, artifactId: artifact.artifactId, digest: artifact.artifactDigest,
                    hostUiApiRange: artifact.hostUiApiRange, releaseVersion: installed.release.ref.version }) });
        }
        const bundled = readCurrentHostBundle(state, scope, hostBundledUi, slot.pluginId);
        if (bundled) {
            const artifacts = (bundled.artifactGraphsByContributionId.get(slot.contributionId) ?? [])
                .filter(graph => graph.tier === slot.tier);
            const execution = readAccountExecutionSelection(state, scope, slot.pluginId);
            const accountAction = execution.kind === 'available' ? execution.manifest.contributes.actions?.find(action =>
                action.id === slot.contributionId && action.execution.target === 'account') : undefined;
            if (execution.kind === 'available' && accountAction?.execution.target === 'account') {
                const reference = accountAction.execution.account;
                artifacts.push(...accountActionArtifactGraphs(execution, hostBundledUi).filter(graph => graph.tier === 'reactNative' && graph.tier === slot.tier
                    && graph.artifactId === reference.artifactId && graph.executable.exports.includes(reference.exportName)));
            }
            if (artifacts.length > 1) return Object.freeze({ kind: 'unavailable', code: 'artifact_slot_ambiguous' });
            if (artifacts.length === 1) {
                const artifact = artifacts[0]!;
                return Object.freeze({ kind: 'available', availabilityCursor: state!.snapshot.availabilityCursor,
                    artifact: Object.freeze({ ...slot, artifactId: artifact.artifactId, digest: artifact.digest,
                        hostUiApiRange: artifact.hostUiApiRange, releaseVersion: bundled.pluginVersion }) });
            }
        }
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
        artifactId: releaseSlot.artifactId,
        tier: releaseSlot.tier,
        platform: releaseSlot.platform,
        digest: releaseSlot.artifactDigest,
        hostUiApiRange: releaseSlot.hostUiApiRange,
        releaseVersion: current.release.ref.version,
    });
    const exactHostedLink = hosted.exactHostedLink;
    const artifact: PluginAccountAvailabilityArtifactFact = exactHostedLink
        ? Object.freeze({
            ...selected,
            accountArtifactId: exactHostedLink.accountArtifactId,
        })
        : selected;
    return Object.freeze({
        kind: 'available',
        availabilityCursor: current.availabilityCursor,
        artifact: cloneArtifact(artifact),
    });
}

/** Shared Account eligibility for bundled and explicitly selected development UI. */
function readCurrentNonPortableUiSnapshot(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    pluginId: string,
): PluginAccountAvailabilitySnapshot | null {
    const snapshot = readProjectionForScope(state, scope);
    if (!snapshot || state?.retiredPluginIds?.includes(pluginId)) return null;
    const intents = state!.intentReadsByPluginId.get(pluginId) ?? [];
    if (intents.length > 1 || intents.some(entry => entry.response.intent
        && (entry.response.intent.pluginId !== pluginId
            || !entry.response.intent.enabled || entry.response.intent.desiredVersion !== null))) return null;
    return snapshot;
}

function readCurrentHostBundle(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    hostBundledUi: readonly PreparedBundledUiDeclaration[],
    pluginId: string,
): PreparedBundledUiDeclaration | null {
    if (!readCurrentNonPortableUiSnapshot(state, scope, pluginId)) return null;
    const bundles = hostBundledUi.filter(candidate => candidate.pluginId === pluginId);
    return bundles.length === 1 ? bundles[0]! : null;
}

type BundledAccountExecution = NonNullable<Parameters<typeof resolvePluginAccountExecutionSelectionV1>[0]['bundled']>;

type PreparedBundledUiDeclaration = PluginHostBundledUiDeclaration & Readonly<{
    accountExecution: BundledAccountExecution | null;
    accountActionArtifactGraphs: readonly PluginUiArtifactsManifestEntryV2[];
    artifactGraphsByContributionId: ReadonlyMap<string, readonly PluginUiArtifactsManifestEntryV2[]>;
}>;

/** Acquisition owns immutable content; selection still reads current Account policy. */
function prepareBundledUiDeclarations(bundles: readonly PluginHostBundledUiDeclaration[]): readonly PreparedBundledUiDeclaration[] {
    return Object.freeze(bundles.map(bundle => {
        // These static declarations come from the build-owned semantic producer.
        // Preserve that admitted graph rather than re-parsing or cloning it.
        const declaration = freezeDeepDeclaration(bundle);
        const sourceManifest = declaration.normalizedManifest?.id === declaration.pluginId
            && declaration.normalizedManifest.version === declaration.pluginVersion ? declaration.normalizedManifest : null;
        // Serialized compiler output cannot carry the decoder's process-local
        // schema preparation. Initialize only those point schemas once here.
        const contributes = sourceManifest ? preparePluginContributionPointDeclarationsV1(sourceManifest.contributes) : null;
        const manifest = sourceManifest && contributes && contributes !== sourceManifest.contributes
            ? freezeDeepDeclaration({ ...sourceManifest, contributes }) : sourceManifest;
        const artifactGraphs = declaration.artifactGraphs ?? Object.freeze([]);
        const entriesById = declaration.entriesById;
        const declaredArtifactGraphs = Object.values(entriesById).flatMap(entry => {
            const graph = entry.artifactGraph as PluginUiArtifactsManifestEntryV2 | undefined;
            return typeof entry.contributionId === 'string' && graph
                ? [Object.freeze({ contributionId: entry.contributionId, graph })] : [];
        });
        const artifactGraphsByContributionId = new Map([...indexAvailabilityRows(declaredArtifactGraphs, entry => entry.contributionId)]
            .map(([id, entries]) => [id, Object.freeze(entries.map(entry => entry.graph))]));
        return Object.freeze({
            ...declaration,
            entriesById,
            artifactGraphs,
            accountActionArtifactGraphs: distinctAccountActionArtifactGraphs(artifactGraphs),
            artifactGraphsByContributionId,
            ...(manifest ? { normalizedManifest: manifest } : {}),
            accountExecution: manifest ? createPluginAccountBundledSelectionV1({ packageName: declaration.packageName, manifest }) : null,
        });
    }));
}

function readAccountExecutionSelection(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    pluginId: string,
): PluginAccountExecutionAdmission {
    const snapshot = readProjectionForScope(state, scope);
    if (!snapshot) return Object.freeze({ kind: 'unavailable', code: state
        ? 'account_availability_scope_mismatch' : 'account_availability_not_loaded' });
    if (state?.retiredPluginIds?.includes(pluginId)) return Object.freeze({ kind: 'unavailable', code: 'plugin_account_execution_unavailable' });
    const reads = state!.intentReadsByPluginId.get(pluginId) ?? [];
    if (reads.length > 1) return Object.freeze({ kind: 'unavailable', code: 'plugin_release_unavailable' });
    const bundles = state!.bundledUiByPluginId.get(pluginId) ?? [];
    const bundle = bundles.length === 1 ? bundles[0] : undefined;
    const bundled = bundle?.accountExecution;
    return resolvePluginAccountExecutionSelectionV1({ pluginId, intentRead: reads[0]?.response ?? null,
        ...(bundled ? { bundled } : {}),
    });
}

function readAccountExecutionSelections(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    hostBundledUi: readonly PreparedBundledUiDeclaration[],
): readonly Extract<PluginAccountExecutionSelectionV1, { kind: 'available' }>[] {
    const snapshot = readProjectionForScope(state, scope);
    if (!snapshot) return Object.freeze([]);
    const pluginIds = new Set([...snapshot.intentReads.map(row => row.pluginId), ...hostBundledUi.map(row => row.pluginId)]);
    return Object.freeze([...pluginIds].sort().flatMap(pluginId => {
        const selected = readAccountExecutionSelection(state, scope, pluginId);
        return selected.kind === 'available' ? [selected] : [];
    }));
}

function accountActionArtifactGraphs(
    selection: Extract<PluginAccountExecutionSelectionV1, { kind: 'available' }>,
    hostBundledUi: readonly PreparedBundledUiDeclaration[],
): readonly PluginUiArtifactsManifestEntryV2[] {
    // Bundled declarations are immutable for this reader's lifetime. Prepare
    // their graph identity once, not in each live Artifact currentness predicate.
    if (!selection.release) return hostBundledUi.find(bundle => bundle.pluginId === selection.manifest.id)?.accountActionArtifactGraphs ?? [];
    return distinctAccountActionArtifactGraphs(selection.release.uiSlots.flatMap(slot => slot.artifactGraph ? [slot.artifactGraph] : []));
}

function distinctAccountActionArtifactGraphs(graphs: readonly PluginUiArtifactsManifestEntryV2[]): readonly PluginUiArtifactsManifestEntryV2[] {
    return Object.freeze([...new Map(graphs.map(graph => [createCanonicalJsonSigningInput(graph), graph])).values()]);
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
            slot: freezeAvailabilitySnapshotValue({ ...hosted.releaseSlot }),
        }),
    });
}

function clonePackageAssetDescriptor(
    descriptor: PackageAssetArchiveDescriptorV1,
): PackageAssetArchiveDescriptorV1 {
    return freezeAvailabilitySnapshotValue({
        archiveDigestSha256: descriptor.archiveDigestSha256,
        resources: freezeAvailabilitySnapshotValue(descriptor.resources.map((resource) => freezeAvailabilitySnapshotValue({ ...resource }))),
    });
}

function isAccountArtifactHostingAdmitted(current: Extract<CurrentReleaseAdmission, { kind: 'available' }>): boolean {
    return current.hostingCapability.enabled === true && current.intent.offlineUiHosting === 'enabled';
}

function selectExactHostedPackageAssetLinks(current: Extract<CurrentReleaseAdmission, { kind: 'available' }>) {
    return current.packageAssets.filter((link) => (
        link.release.pluginId === current.release.ref.pluginId
        && link.release.version === current.release.ref.version
        && link.descriptor.archiveDigestSha256 === current.release.packageAssetArchive.archiveDigestSha256
        && JSON.stringify(link.descriptor.resources) === JSON.stringify(current.release.packageAssetArchive.resources)
    ));
}

function readCurrentHostedPackageAssetPublicationAdmission(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    input: Readonly<{ pluginId: string }>,
): PluginAccountAvailabilityHostedPackageAssetPublicationAdmission {
    const current = readCurrentReleaseAdmission(state, scope, input.pluginId);
    if (current.kind !== 'available') return current;
    if (!current.intent.enabled || current.release.packageAssetArchive.resources.length === 0) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_not_current' });
    }
    if (!isAccountArtifactHostingAdmitted(current)) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_hosting_not_admitted' });
    }
    const links = selectExactHostedPackageAssetLinks(current);
    if (links.length > 1) return Object.freeze({ kind: 'unavailable', code: 'artifact_slot_ambiguous' });
    if (links.length === 1) return Object.freeze({ kind: 'unavailable', code: 'artifact_already_hosted' });
    return Object.freeze({
        kind: 'available',
        availabilityCursor: current.availabilityCursor,
        target: Object.freeze({
            release: Object.freeze({ ...current.release.ref }),
            normalizedManifest: current.release.normalizedManifest,
            descriptor: current.release.packageAssetArchive,
        }),
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

/**
 * A release-less intent is a daemon-claimed Collection writer pointer for a
 * bundled, development, or drop-in plugin. It carries Data authority only
 * (Collections and the plugin's own Account KV) and never selects release UI,
 * artifacts, or package assets.
 */
function readCurrentReleaseLessIntent(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    pluginId: string,
): Readonly<{
    availabilityCursor: number;
    intent: NonNullable<PluginAccountAvailabilityIntentReadProjection['response']['intent']>;
}> | null {
    const snapshot = state ? readProjectionForScope(state, scope) : null;
    const projections = snapshot ? state!.intentReadsByPluginId.get(pluginId) ?? [] : [];
    if (projections.length !== 1) return null;
    const { response } = projections[0]!;
    return response.intent?.pluginId === pluginId && response.intent.desiredVersion === null
        ? { availabilityCursor: response.availabilityCursor, intent: response.intent }
        : null;
}

function readCurrentCollectionContractAdmission(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    input: Readonly<{ pluginId: string; collectionId: string; ref?: PluginCollectionContractRefV1 }>,
    hostBundledUi: readonly PreparedBundledUiDeclaration[],
): PluginAccountAvailabilityCollectionContractAdmission {
    // A claim admits its current writer refs; a release admits its declared
    // refs (older retained reader refs stay with the server's resolver).
    const claimed = readCurrentReleaseLessIntent(state, scope, input.pluginId);
    let current: Readonly<{
        availabilityCursor: number;
        enabled: boolean;
        contracts: readonly PluginCollectionContractRefV1[];
    }>;
    if (claimed) {
        current = {
            availabilityCursor: claimed.availabilityCursor,
            enabled: claimed.intent.enabled,
            contracts: claimed.intent.writableCollections,
        };
    } else {
        const release = readCurrentReleaseAdmission(state, scope, input.pluginId);
        if (release.kind !== 'available') {
            return Object.freeze({ kind: 'unavailable', code: release.code });
        }
        current = {
            availabilityCursor: release.availabilityCursor,
            enabled: release.intent.enabled,
            contracts: release.release.collectionContracts,
        };
    }
    if (!current.enabled) {
        return Object.freeze({ kind: 'unavailable', code: 'collection_not_current' });
    }
    const contracts = current.contracts;
    const candidates = contracts.filter((candidate) => (
        candidate.pluginId === input.pluginId
        && candidate.collectionId === input.collectionId
    ));
    if (candidates.length === 0) {
        return Object.freeze({ kind: 'unavailable', code: 'collection_not_current' });
    }
    if (candidates.length !== 1) {
        return Object.freeze({ kind: 'unavailable', code: 'collection_slot_ambiguous' });
    }
    // An app-bundled query uses the contract compiled with its reader. A newer
    // daemon writer is not evidence that this app understands those rows.
    // Data's exact-ref resolver owns compatibility, including retained readers.
    const bundle = readCurrentHostBundle(state, scope, hostBundledUi, input.pluginId);
    const compiled = bundle?.collectionContracts?.filter(ref => ref.collectionId === input.collectionId);
    const ref = input.ref ?? (bundle ? compiled?.length === 1 ? compiled[0] : undefined : candidates[0]);
    if (!ref) return Object.freeze({ kind: 'unavailable', code: 'collection_not_current' });
    if (ref.pluginId !== input.pluginId || ref.collectionId !== input.collectionId) {
        return Object.freeze({ kind: 'unavailable', code: 'collection_not_current' });
    }
    // Data resolves compatibility and read/write access for this exact ref.
    // Availability never substitutes the current writer's digest for a caller.
    return Object.freeze({
        kind: 'available',
        availabilityCursor: current.availabilityCursor,
        ref: Object.freeze({ ...ref }),
    });
}

function releaseRequiresAccountKv(manifest: PluginPortableReleaseManifestV1): boolean {
    return manifest.hostAccess.required.some(
        (request) => request.capability === 'storage.account',
    );
}

function readCurrentAccountDataCapabilityAdmission(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    input: Readonly<{ pluginId: string }>,
): PluginAccountAvailabilityDataCapabilityAdmission {
    const claimed = readCurrentReleaseLessIntent(state, scope, input.pluginId);
    if (claimed) {
        return claimed.intent.enabled && claimed.intent.writableCollections.length > 0
            ? Object.freeze({ kind: 'available', availabilityCursor: claimed.availabilityCursor })
            : Object.freeze({ kind: 'unavailable', code: 'account_data_not_current' });
    }
    const current = readCurrentReleaseAdmission(state, scope, input.pluginId);
    if (current.kind !== 'available') {
        return Object.freeze({ kind: 'unavailable', code: current.code });
    }
    const accountKvDeclared = releaseRequiresAccountKv(current.release.normalizedManifest);
    if (
        !current.intent.enabled
        || (current.release.collectionContracts.length === 0 && !accountKvDeclared)
    ) {
        return Object.freeze({ kind: 'unavailable', code: 'account_data_not_current' });
    }
    return Object.freeze({
        kind: 'available',
        availabilityCursor: current.availabilityCursor,
    });
}

function readCurrentAccountKvCapabilityAdmission(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    input: Readonly<{ pluginId: string }>,
    hostBundledUi: readonly PreparedBundledUiDeclaration[] = [],
): PluginAccountAvailabilityAccountKvAdmission {
    // A daemon claim comes from the plugin's own admitted manifest, so it
    // admits that plugin's Account KV exactly as it admits its Collections.
    const claimed = readCurrentReleaseLessIntent(state, scope, input.pluginId);
    if (claimed) {
        return claimed.intent.enabled
            ? Object.freeze({ kind: 'available', availabilityCursor: claimed.availabilityCursor })
            : Object.freeze({ kind: 'unavailable', code: 'account_kv_not_current' });
    }
    const current = readCurrentReleaseAdmission(state, scope, input.pluginId);
    if (current.kind !== 'available') {
        const selected = readAccountExecutionSelection(state, scope, input.pluginId);
        if (selected.kind === 'available' && releaseRequiresAccountKv(selected.manifest)) {
            return Object.freeze({ kind: 'available', availabilityCursor: state!.snapshot.availabilityCursor });
        }
        return Object.freeze({ kind: 'unavailable', code: current.code });
    }
    const accountKvDeclared = releaseRequiresAccountKv(current.release.normalizedManifest);
    if (!current.intent.enabled || !accountKvDeclared) {
        return Object.freeze({ kind: 'unavailable', code: 'account_kv_not_current' });
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

type AvailabilityAccountUiProjection = Readonly<{
    bundles: readonly PreparedBundledUiDeclaration[];
    selections: ReturnType<typeof readAccountExecutionSelections>;
    model: PluginUiProjectionModel | null;
}>;

type AvailabilityDerivedProjection = Readonly<{
    materializations: PluginMachineMaterializationAdmission;
    installed: PluginAccountInstalledPluginsAdmission;
    accountUi: AvailabilityAccountUiProjection;
    uiInputs: PluginAccountUiProjectionInputs;
}>;

function retainUiMaterializations(previous: readonly PluginMachineMaterializationV1[] | undefined,
    next: readonly PluginMachineMaterializationV1[]): readonly PluginMachineMaterializationV1[] {
    const rows = next.map((row, index) => samePluginUiMaterializationFacts(previous?.[index], row) ? previous![index]! : row);
    return previous?.length === rows.length && rows.every((row, index) => row === previous[index])
        ? previous : Object.freeze(rows);
}

/** Reuse ingestion-owned declaration/model references; never compare manifests again here. */
function retainUiInstalledPlugins(previous: PluginAccountUiProjectionInputs['installedPlugins'],
    next: PluginAccountUiProjectionInputs['installedPlugins']): PluginAccountUiProjectionInputs['installedPlugins'] {
    if (!next) return next;
    const plugins = next.map((plugin, index) => {
        const prior = previous?.[index]?.pluginId === plugin.pluginId ? previous[index] : undefined;
        const installations = plugin.installations.map((installation, rowIndex) => {
            const before = prior?.installations[rowIndex];
            const execution = retainUnchangedAvailabilityValue(before?.execution, installation.execution);
            if (before && samePluginUiMaterializationFacts(before.materialization, installation.materialization)
                && before.declaration === installation.declaration && before.release === installation.release
                && before.declarationState === installation.declarationState && before.uiDeclarationState === installation.uiDeclarationState
                && before.uiModel === installation.uiModel && before.execution === execution) return before;
            return installation;
        });
        return prior?.installations.length === installations.length
            && installations.every((installation, rowIndex) => installation === prior.installations[rowIndex])
            ? prior : Object.freeze({ ...plugin, installations: Object.freeze(installations) });
    });
    return previous?.length === plugins.length && plugins.every((plugin, index) => plugin === previous[index])
        ? previous : Object.freeze(plugins);
}

/** Share unchanged family rows once, when this descriptive model is published. */
function retainAccountUiProjectionRows(previous: PluginUiProjectionModel | null | undefined, next: PluginUiProjectionModel | null): PluginUiProjectionModel | null {
    if (!previous || !next) return next;
    const families = Object.fromEntries(Object.entries(next).map(([key, value]) => {
        const before: unknown = previous[key as keyof PluginUiProjectionModel];
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || !before || typeof before !== 'object' || Array.isArray(before)) {
            return [key, retainUnchangedAvailabilityValue(before, value)];
        }
        const previousRows = before as Readonly<Record<string, unknown>>;
        const rows = Object.freeze(Object.fromEntries(Object.entries(value).map(([id, row]) =>
            [id, retainUnchangedAvailabilityValue(previousRows[id], row)])));
        return [key, retainUnchangedAvailabilityValue(before, rows)];
    }));
    return retainUnchangedAvailabilityValue(previous, Object.freeze({ ...next, ...families }));
}

type AvailabilityObservation = Readonly<{
    value: Readonly<{
        scope: ServerAccountScope;
        inventoryComplete: boolean;
        retired: boolean;
        intentReads: readonly PluginAccountAvailabilityIntentReadProjection[];
        materializations: readonly PluginMachineMaterializationV1[];
        releases: readonly PluginReleaseFactsV1[];
        snapshots: readonly PluginMachineMaterializationSnapshotV1[];
    }>;
    token: object;
}>;

type AvailabilityObservations = Readonly<{
    all: object;
    empty: AvailabilityObservation;
    byPluginId: ReadonlyMap<string, AvailabilityObservation>;
}>;

function deriveAvailabilityObservations(state: AvailabilityProjectionState, previous?: AvailabilityObservations,
    previousCursor?: number): AvailabilityObservations {
    const { snapshot } = state;
    const intents = state.intentReadsByPluginId;
    const materializations = indexAvailabilityRows(snapshot.materializations, row => row.pluginId);
    const releases = indexAvailabilityRows(snapshot.releases ?? [], row => row.ref.pluginId);
    const retired = new Set(state.retiredPluginIds);
    const observe = (value: AvailabilityObservation['value'], prior?: AvailabilityObservation): AvailabilityObservation =>
        prior && sameStrictJsonValue(prior.value, value) ? prior : Object.freeze({ value, token: Object.freeze({}) });
    const empty = observe(Object.freeze({ scope: state.scope, inventoryComplete: snapshot.inventoryComplete !== false,
        retired: false, intentReads: Object.freeze([]), materializations: Object.freeze([]),
        releases: Object.freeze([]), snapshots: snapshot.snapshots }), previous?.empty);
    const byPluginId = new Map<string, AvailabilityObservation>();
    for (const pluginId of new Set([...intents.keys(), ...materializations.keys(), ...releases.keys(), ...retired])) {
        byPluginId.set(pluginId, observe(Object.freeze({ ...empty.value,
            retired: retired.has(pluginId),
            intentReads: Object.freeze(intents.get(pluginId) ?? []),
            materializations: Object.freeze(materializations.get(pluginId) ?? []),
            releases: Object.freeze(releases.get(pluginId) ?? []),
        }), previous?.byPluginId.get(pluginId) ?? previous?.empty));
    }
    const unchanged = previousCursor === snapshot.availabilityCursor
        && previous?.empty === empty && previous.byPluginId.size === byPluginId.size
        && [...byPluginId].every(([pluginId, observation]) => previous.byPluginId.get(pluginId) === observation);
    return Object.freeze({ all: unchanged ? previous.all : Object.freeze({}), empty, byPluginId });
}

function deriveAccountUiProjection(input: Readonly<{
    scope: ServerAccountScope;
    hostBundledUi: readonly PreparedBundledUiDeclaration[];
}>, state: AvailabilityProjectionState, previous?: AvailabilityAccountUiProjection): AvailabilityAccountUiProjection {
    const bundles = (input.hostBundledUi ?? []).filter(bundle =>
        readCurrentHostBundle(state, input.scope, input.hostBundledUi ?? [], bundle.pluginId));
    const selections = readAccountExecutionSelections(state, input.scope, input.hostBundledUi ?? []);
    if (previous?.bundles?.length === bundles.length
        && bundles.every((bundle, index) => bundle === previous?.bundles![index])
        && sameStrictJsonValue(previous?.selections, selections)) {
        return { bundles, selections, model: previous?.model ?? null };
    }
    const entries = Object.assign({}, ...bundles.map(bundle => bundle.entriesById),
        ...selections.map(selected => {
            const declarations = projectPluginPortableUiDeclarationsV1(
                selected.manifest, accountActionArtifactGraphs(selected, input.hostBundledUi ?? []),
            );
            return selected.release && selected.manifest.contributes.actions?.some(action => action.execution.target === 'account')
                ? declarations
                : Object.fromEntries(Object.entries(declarations).filter(([, entry]) => entry.contributionKind === 'uiRenderer'));
        }));
    const accountUiOrigins = new Map(selections.map(({ manifest, custodyId, sourceCustody }) => [manifest.id,
        Object.freeze({ ...input.scope, custodyId, sourceCustody }),
    ] as const));
    const actions: Record<string, PluginUiActionProjection> = {};
    for (const selected of selections) {
        const { manifest, custodyId } = selected;
        const hostAccountOrigin = accountUiOrigins.get(manifest.id)!;
        const graphs = accountActionArtifactGraphs(selected, input.hostBundledUi ?? []);
        for (const action of manifest.contributes.actions ?? []) {
            if (action.execution.target !== 'account') continue;
            const execution = action.execution;
            const matchingGraphs = graphs.filter(graph => graph.tier === 'reactNative'
                && graph.artifactId === execution.account.artifactId
                && graph.executable.exports.includes(execution.account.exportName));
            const graph = matchingGraphs.length === 1 ? matchingGraphs[0] : undefined;
            const compatible = graph !== undefined && isPluginUiHostApiVersionCompatibleWithVersionV1(PLUGIN_UI_HOST_API_VERSION_V1, graph.hostUiApiRange);
            const requestedAccess = action.hostAccess ?? [];
            const optionalAccess = manifest.hostAccess.optional.filter(request => requestedAccess.includes(request.id));
            const requiredAccess = manifest.hostAccess.required.filter(request => requestedAccess.includes(request.id));
            const accountKvAdmission = readCurrentAccountKvCapabilityAdmission(state, input.scope, { pluginId: manifest.id }, input.hostBundledUi);
            const key = buildQualifiedPluginContributionKey({ pluginId: manifest.id, localId: action.id });
            actions[key] = Object.freeze({ id: action.id, pluginId: manifest.id,
                pluginVersion: manifest.version, occurrenceId: custodyId, title: action.title,
                ...(action.description ? { description: action.description } : {}),
                ...(action.icon ? { icon: action.icon } : {}),
                scopes: action.scopes, surfaces: action.surfaces, execution,
                ...(action.sessionTarget ? { sessionTarget: action.sessionTarget } : {}),
                placementBindings: action.placementBindings, dangerLevel: action.dangerLevel,
                ...(action.confirmation ? { confirmation: action.confirmation } : {}),
                ...(action.confirmationWhen ? { confirmationWhen: action.confirmationWhen } : {}),
                available: compatible, hostAccountOrigin, accountActionDeclaration: action,
                authorization: { generation: { targetGeneration: custodyId, desiredGeneration: custodyId, appliedGeneration: null },
                    resourceSelections: optionalAccess.map(request => ({ id: request.id, required: true })), scopedGrants: [],
                    serviceAvailability: [...requiredAccess, ...optionalAccess].map(request => ({ id: request.id, required: true,
                        status: requiredAccess.includes(request) && request.capability === 'storage.account'
                            && accountKvAdmission.kind === 'available' ? 'available' as const : 'unavailable' as const })),
                    operatingSystemAuthorization: [] },
            });
            if (graph) {
                const entry = projectPluginReactNativeArtifactEntryV1({ pluginId: manifest.id, pluginVersion: manifest.version,
                    contributionId: action.id, artifactId: graph.artifactId, artifact: graph, generatedOwnerKind: 'clientContribution',
                    artifactSelectionOwner: 'accountRelease', requiredHostMethods: [], exportName: execution.account.exportName,
                    runtime: Object.freeze({ decision: { state: compatible ? 'load' : 'blocked',
                        reason: compatible ? 'compatible' : 'generated_ui_host_api_mismatch',
                        diagnostics: compatible ? [] : ['generated_ui_host_api_mismatch'] },
                        ...(compatible ? { cacheKey: derivePluginReactNativeBundleCacheKey({ artifactDigest: graph.digest }),
                            cacheIdentity: { artifactDigest: graph.digest }, loadPolicy: { source: 'installedArtifact' } } : {}) }),
                });
                entries[entry.id] = Object.freeze({ ...entry, occurrenceId: custodyId, hostAccountOrigin });
            }
        }
    }
    const projection = normalizePluginInstalledUiDeclarations(entries);
    const withAccountOccurrence = <T extends Readonly<{ pluginId: string }>>(entry: T): T => {
        const hostAccountOrigin = accountUiOrigins.get(entry.pluginId);
        return hostAccountOrigin ? Object.freeze({ ...entry, occurrenceId: hostAccountOrigin.custodyId }) : entry;
    };
    const model = Object.keys(entries).length > 0 || Object.keys(actions).length > 0 ? Object.freeze({ ...projection,
        actionsById: Object.freeze(actions),
        reactNativeBundlesById: Object.freeze(Object.fromEntries(Object.entries(projection.reactNativeBundlesById)
            .map(([key, entry]) => [key, withAccountOccurrence(entry)]))),
        hostedWebById: Object.freeze(Object.fromEntries(Object.entries(projection.hostedWebById)
            .map(([key, entry]) => [key, withAccountOccurrence(entry)]))),
        surfacePlacementsById: Object.freeze(Object.fromEntries(Object.entries(projection.surfacePlacementsById)
            .map(([key, entry]) => {
                const hostAccountOrigin = accountUiOrigins.get(entry.pluginId);
                return [key, Object.freeze({ ...entry, hostSupplies: Object.freeze([]),
                    ...(hostAccountOrigin ? { occurrenceId: hostAccountOrigin.custodyId, hostAccountOrigin } : {}) })];
            }))),
        settingsPagesById: Object.freeze(Object.fromEntries(Object.entries(projection.settingsPagesById)
            .map(([key, entry]) => {
                const hostAccountOrigin = accountUiOrigins.get(entry.pluginId);
                return [key, Object.freeze({ ...entry, hostSupplies: Object.freeze([]),
                    ...(hostAccountOrigin ? { occurrenceId: hostAccountOrigin.custodyId, hostAccountOrigin } : {}) })];
            }))),
        installedPackagesById: Object.freeze({ ...Object.fromEntries(bundles.map(bundle => [bundle.pluginId, {
            id: bundle.pluginId, displayName: bundle.displayName,
            version: bundle.pluginVersion, enabled: true, source: { kind: 'bundled' as const, locator: bundle.packageName },
            ...(bundle.declaredExecution ? { declaredExecution: bundle.declaredExecution } : {}),
        }])), ...Object.fromEntries(selections.filter(selected => selected.manifest.contributes.actions?.some(action => action.execution.target === 'account'))
            .map(selected => {
                const bundle = bundles.find(candidate => candidate.pluginId === selected.manifest.id);
                return [selected.manifest.id, { id: selected.manifest.id,
                displayName: typeof selected.manifest.displayName === 'string' ? selected.manifest.displayName : selected.manifest.displayName.fallback,
                version: selected.manifest.version, enabled: true,
                source: selected.release ? { kind: 'archive', locator: selected.release.archiveDigestSha256 }
                    : { kind: 'bundled', locator: bundle!.packageName },
                ...(bundle?.declaredExecution ? { declaredExecution: bundle.declaredExecution } : {}),
            }]; })) }),
    }) : null;
    const retained = retainAccountUiProjectionRows(previous?.model, model);
    const prepared = retained ? preparePluginUiProjectionOrigins(retained) : null;
    return { bundles, selections, model: prepared };
}

function createBoundReader(input: Readonly<{
    scope: ServerAccountScope;
    readState: () => AvailabilityProjectionState | null;
    subscribe: (listener: () => void) => () => void;
    hostBundledUi?: readonly PreparedBundledUiDeclaration[];
    readDerivedProjection: () => AvailabilityDerivedProjection | null;
    readObservationSnapshot: (pluginId?: string) => object | null;
}>): PluginAccountAvailabilityReader {
    return Object.freeze({
        getObservationSnapshot: input.readObservationSnapshot,
        readUiProjectionInputs: () => input.readDerivedProjection()?.uiInputs ?? null,
        readCurrentAccountExecution: (pluginId: string) => readAccountExecutionSelection(input.readState(), input.scope, pluginId),
        readCurrentAccountExecutionDeclarations: () => readAccountExecutionSelections(input.readState(), input.scope, input.hostBundledUi ?? []),
        readAccountUiProjection: () => input.readDerivedProjection()?.accountUi.model ?? null,
        readCurrentArtifact: (slot, executionOrigin, daemonProjectionSelection) => readCurrentArtifactAdmission(
            input.readState(),
            input.scope,
            slot,
            input.hostBundledUi,
            executionOrigin,
            daemonProjectionSelection,
        ),
        readCurrentHostedPublicationTarget: (slot) => readCurrentHostedPublicationAdmission(
            input.readState(),
            input.scope,
            slot,
        ),
        readCurrentHostedPackageAssetPublicationTarget: (packageAsset) => readCurrentHostedPackageAssetPublicationAdmission(
            input.readState(),
            input.scope,
            packageAsset,
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
            input.hostBundledUi ?? [],
        ),
        readCurrentAccountDataCapability: (plugin) => readCurrentAccountDataCapabilityAdmission(
            input.readState(),
            input.scope,
            plugin,
        ),
        readCurrentAccountKvCapability: (plugin) => readCurrentAccountKvCapabilityAdmission(
            input.readState(),
            input.scope,
            plugin,
            input.hostBundledUi,
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
        readCurrentHostedArtifactAdministration: (selection) => readCurrentHostedArtifactAdministrationAdmission(
            input.readState(),
            input.scope,
            selection,
        ),
        classifyRelease: (materialization) => classifyMaterializationRelease(
            input.readState(),
            input.scope,
            materialization,
        ),
        readMaterializations: () => input.readDerivedProjection()?.materializations
            ?? readMaterializationAdmission(input.readState(), input.scope),
        readInstalledPlugins: () => input.readDerivedProjection()?.installed
            ?? readInstalledPluginsAdmission(input.readState(), input.scope),
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
    hostBundledUi?: readonly PluginHostBundledUiDeclaration[];
}>): PluginAccountAvailabilityReader {
    const store = createPluginAccountAvailabilityReaderStore({ hostBundledUi: input.hostBundledUi });
    store.replace(input);
    return store.bind(input.scope);
}

/**
 * The live Account projection owner. Account-change consumers replace one
 * complete materialization snapshot and publishes its descriptive slices before
 * notifying readers. Operation policy remains a live read of this owner.
 */
export function createPluginAccountAvailabilityReaderStore(input: Readonly<{
    hostBundledUi?: readonly PluginHostBundledUiDeclaration[];
    loadHostBundledUi?: never;
}> | Readonly<{
    hostBundledUi?: never;
    /** App-owned package facts are acquired before the first Account publication, not anonymous boot. */
    loadHostBundledUi: () => readonly PluginHostBundledUiDeclaration[];
}> = {}): PluginAccountAvailabilityReaderStore {
    let loadHostBundledUi = input.loadHostBundledUi;
    let hostBundledUi = loadHostBundledUi ? Object.freeze([]) : prepareBundledUiDeclarations(input.hostBundledUi ?? []);
    let bundledUiByPluginId = indexAvailabilityRows(hostBundledUi, bundle => bundle.pluginId);
    let state: AvailabilityProjectionState | null = null;
    let derived: AvailabilityDerivedProjection | null = null;
    let observations: AvailabilityObservations | undefined;
    let boundReader: Readonly<{ scope: ServerAccountScope; reader: PluginAccountAvailabilityReader }> | undefined;
    const getObservationSnapshot = (pluginId?: string): object | null => {
        if (!state || !observations) return null;
        return pluginId === undefined ? observations.all
            : (observations.byPluginId.get(pluginId) ?? observations.empty).token;
    };
    const publish = (next: PluginAccountAvailabilityStoredProjection) => {
        if (loadHostBundledUi) {
            const acquired = prepareBundledUiDeclarations(loadHostBundledUi());
            const indexed = indexAvailabilityRows(acquired, bundle => bundle.pluginId);
            hostBundledUi = acquired;
            bundledUiByPluginId = indexed;
            loadHostBundledUi = undefined;
        }
        const sameScope = state !== null && areServerAccountScopesEqual(state.scope, next.scope);
        if (sameScope && state!.snapshot.availabilityCursor === next.snapshot.availabilityCursor
            && state!.snapshot.inventoryComplete === next.snapshot.inventoryComplete
            && state!.snapshot.intentReads === next.snapshot.intentReads
            && state!.snapshot.materializations === next.snapshot.materializations
            && state!.snapshot.snapshots === next.snapshot.snapshots
            && state!.snapshot.releases === next.snapshot.releases
            && sameStrictJsonValue(state!.stalePluginIds, next.stalePluginIds)
            && sameStrictJsonValue(state!.retiredPluginIds ?? [], next.retiredPluginIds ?? [])) return false;
        const nextState = Object.freeze({ ...next,
            bundledUiByPluginId,
            intentReadsByPluginId: sameScope && state!.snapshot.intentReads === next.snapshot.intentReads
                ? state!.intentReadsByPluginId : indexAvailabilityRows(next.snapshot.intentReads, row => row.pluginId),
            materializationsByIdentity: sameScope && state!.snapshot.materializations === next.snapshot.materializations
                ? state!.materializationsByIdentity : indexMaterializations(next.snapshot),
        });
        const nextProjection = {
            materializations: retainUnchangedAvailabilityValue(sameScope ? derived?.materializations : undefined,
                readMaterializationAdmission(nextState, nextState.scope)),
            installed: readInstalledPluginsAdmission(nextState, nextState.scope, sameScope ? derived?.installed : undefined),
            accountUi: deriveAccountUiProjection({ scope: nextState.scope, hostBundledUi }, nextState,
                sameScope ? derived?.accountUi : undefined),
        };
        const previousInputs = sameScope ? derived?.uiInputs : undefined;
        const materializations = retainUiMaterializations(previousInputs?.materializations,
            nextProjection.materializations.kind === 'available' ? nextProjection.materializations.materializations : []);
        const installedPlugins = retainUiInstalledPlugins(previousInputs?.installedPlugins,
            nextProjection.installed.kind === 'available' ? nextProjection.installed.plugins : undefined);
        const accountUiProjection = nextProjection.accountUi.model;
        const uiInputs = previousInputs && previousInputs.materializations === materializations
            && previousInputs.installedPlugins === installedPlugins && previousInputs.accountUiProjection === accountUiProjection
            && state!.snapshot.inventoryComplete === nextState.snapshot.inventoryComplete
            && sameStrictJsonValue(state!.retiredPluginIds ?? [], nextState.retiredPluginIds ?? [])
            ? previousInputs : Object.freeze({ materializations, installedPlugins, accountUiProjection });
        const nextDerived = Object.freeze({ ...nextProjection, uiInputs });
        const nextObservations = deriveAvailabilityObservations(nextState, sameScope ? observations : undefined,
            state?.snapshot.availabilityCursor);
        state = nextState;
        derived = nextDerived;
        observations = nextObservations;
        return true;
    };
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
            const canMerge = previous !== null && areServerAccountScopesEqual(previous.scope, input.scope);
            const incoming = snapshotPluginAccountAvailabilitySnapshot(input.snapshot, canMerge ? previous.snapshot : undefined);
            const replacedMachineKeys = new Set(incoming.snapshots.map((entry) => `${entry.serverIdentityId}\0${entry.machineId}`));
            const retainedSnapshots = canMerge && incoming.inventoryComplete === false
                ? previous.snapshot.snapshots.filter((entry) => !replacedMachineKeys.has(`${entry.serverIdentityId}\0${entry.machineId}`))
                : [];
            const retainedMaterializations = canMerge && incoming.inventoryComplete === false
                ? previous.snapshot.materializations.filter((entry) => !replacedMachineKeys.has(`${entry.serverIdentityId}\0${entry.machineId}`))
                : [];
            const retainedReleases = canMerge && incoming.inventoryComplete === false
                ? (previous.snapshot.releases ?? []).filter(release => retainedMaterializations.some(
                    materialization => isExactPluginMachineMaterializationReleaseCorrespondenceV1(materialization, release),
                )) : [];
            const replacedPluginIds = new Set(incoming.intentReads.map((entry) => entry.pluginId));
            const retainedIntentReads = canMerge
                ? previous.snapshot.intentReads.filter((entry) => !replacedPluginIds.has(entry.pluginId))
                : [];
            const previousIntentReads = new Map(canMerge ? previous.snapshot.intentReads.map(entry => [entry.pluginId, entry]) : []);
            const intentReads = retainUnchangedAvailabilityRows(canMerge ? previous.snapshot.intentReads : undefined,
                Object.freeze([...retainedIntentReads, ...incoming.intentReads]
                .map(entry => Object.freeze({ ...entry, response: Object.freeze({ ...entry.response,
                    release: retainUnchangedAvailabilityValue(previousIntentReads.get(entry.pluginId)?.response.release, entry.response.release),
                }) }))
                .sort((left, right) => left.pluginId.localeCompare(right.pluginId))));
            const retainedPluginIds = new Set(intentReads.map((entry) => entry.pluginId));
            const stalePluginIds = new Set(canMerge ? previous.stalePluginIds : []);
            for (const pluginId of replacedPluginIds) stalePluginIds.delete(pluginId);
            if (input.intentCensusIncomplete) {
                for (const entry of retainedIntentReads) stalePluginIds.add(entry.pluginId);
            }
            for (const pluginId of input.failedPluginIds ?? []) {
                if (retainedPluginIds.has(pluginId)) stalePluginIds.add(pluginId);
            }
            const changed = publish(Object.freeze({
                scope: Object.freeze({ ...input.scope }),
                retiredPluginIds: canMerge ? previous.retiredPluginIds?.filter(pluginId => !replacedPluginIds.has(pluginId)) : [],
                stalePluginIds: Object.freeze([...stalePluginIds].sort((left, right) => left.localeCompare(right))),
                snapshot: Object.freeze({
                    ...incoming,
                    availabilityCursor: Math.max(
                        incoming.availabilityCursor,
                        ...incoming.intentReads.map((entry) => entry.response.availabilityCursor),
                        ...(canMerge ? retainedIntentReads.map((entry) => entry.response.availabilityCursor) : []),
                    ),
                    intentReads,
                    snapshots: retainUnchangedAvailabilityRows(canMerge ? previous.snapshot.snapshots : undefined,
                        Object.freeze([...retainedSnapshots, ...incoming.snapshots])),
                    materializations: retainUnchangedAvailabilityRows(canMerge ? previous.snapshot.materializations : undefined,
                        Object.freeze([...retainedMaterializations, ...incoming.materializations])),
                    releases: retainUnchangedAvailabilityRows(canMerge ? previous.snapshot.releases : undefined,
                        Object.freeze([...retainedReleases, ...(incoming.releases ?? [])])),
                }),
            }));
            if (changed) notify();
            return previous;
        },
        clear: () => {
            const previous = state;
            if (!previous) return previous;
            state = null;
            derived = null;
            observations = undefined;
            notify();
            return previous;
        },
        retire: (pluginIds) => {
            if (!state || pluginIds.length === 0) return;
            if (pluginIds.every(pluginId => state!.retiredPluginIds?.includes(pluginId))) return;
            const retired = new Set(pluginIds);
            const intentReads = state.snapshot.intentReads.filter((entry) => !retired.has(entry.pluginId));
            publish(Object.freeze({
                scope: state.scope,
                snapshot: Object.freeze({ ...state.snapshot, intentReads: Object.freeze(intentReads) }),
                stalePluginIds: Object.freeze(state.stalePluginIds.filter((pluginId) => !retired.has(pluginId))),
                retiredPluginIds: Object.freeze([...new Set([...(state.retiredPluginIds ?? []), ...pluginIds])]),
            }));
            notify();
        },
        getSnapshot: () => state,
        getObservationSnapshot,
        subscribe,
        bind: (scope) => {
            if (boundReader && areServerAccountScopesEqual(boundReader.scope, scope)) return boundReader.reader;
            const scoped = Object.freeze({ ...scope });
            const reader = createBoundReader({
                scope: scoped,
                readState: () => state,
                subscribe,
                get hostBundledUi() { return hostBundledUi; },
                readDerivedProjection: () => state && areServerAccountScopesEqual(state.scope, scoped) ? derived : null,
                readObservationSnapshot: (pluginId) => state && areServerAccountScopesEqual(state.scope, scoped)
                    ? getObservationSnapshot(pluginId) : null,
            });
            if (!state || areServerAccountScopesEqual(state.scope, scoped)) boundReader = { scope: scoped, reader };
            return reader;
        },
    });
}
