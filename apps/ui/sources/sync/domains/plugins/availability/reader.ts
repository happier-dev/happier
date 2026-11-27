import { compareCodeUnits } from '@/utils/strings/compareCodeUnits';
import type {
    PackageAssetArchiveDescriptorV1,
    PluginAccountAvailabilityIntentReadResponseV1,
    PluginAccountPluginIntentV1,
    PluginAccountDeclarationBodyV1,
    PluginMachineMaterializationSnapshotV1,
    PluginMachineMaterializationV1,
    PluginMachineMaterializationRefV1,
    PluginPortableReleaseManifestV1,
    PluginReleaseFactsV1,
} from '@happier-dev/protocol/plugins/availability';
import {
    isAdmittedPluginMachineUiArtifactSetV1,
    isExactPluginMachineMaterializationReleaseCorrespondenceV1,
    isPluginUiReleaseSlotCompatibleWithArtifactLinkV1,
    snapshotPluginReleaseFactsV1,
    resolvePluginAccountExecutionSelectionV1,
    createPluginAccountBundledSelectionV1,
    type PluginAccountExecutionSelectionV1,
} from '@happier-dev/protocol/plugins/availability';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/public-types';
import { normalizePluginActionInputHintsV2, overlayPluginActionAuthoredInputHintsV2 } from '@happier-dev/protocol/plugins/actions/v2';
import { derivePluginAccountExecutionArtifactSlots, derivePluginContributionRegistrationRights } from '@happier-dev/protocol/plugins/contributions/catalog';
import { PluginUiArtifactsManifestEntryV2Schema, isPluginUiExecutableArtifactHostCompatibleV1, PLUGIN_UI_HOST_API_VERSION_V1,
    type PluginUiArtifactsManifestEntryV2, type PluginUiArtifactDigestV1 } from '@happier-dev/protocol/plugins/ui';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { buildQualifiedPluginContributionKey, qualifyPluginContributionReferenceV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { resolveConnectedAccountNativeLoginConstraintsV1 } from '@happier-dev/protocol/teams';
import { projectPluginReactNativeArtifactEntryV1 } from '@happier-dev/protocol/plugins/contributions/ui';
import type { PluginCollectionContractRefV1 } from '@happier-dev/protocol/plugins/data/collectionContractRefV1';
import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { projectPluginPortableUiDeclarationsV1 } from '@happier-dev/protocol/plugins/contributions/ui';
import { preparePluginContributionPointDeclarationsV1 } from '@happier-dev/protocol/plugins/contributions/targeted';
import { samePluginUiMaterializationFacts, normalizePluginInstalledUiDeclarations, type PluginUiActionProjection, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { readPluginMachineMaterializations } from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import { preparePluginUiProjectionOrigins } from '@/sync/domains/plugins/ui/projectionOrigins';
import { projectPluginRegistrySourceDeclarationV1 } from '@happier-dev/protocol/registries';
import { projectPluginSkillDeclarationV1 } from '@happier-dev/protocol/plugins/contributions/skills';
import { projectPluginSubjectKindDeclarationV1 } from '@happier-dev/protocol/plugins/contributions/subjectKinds';
import { projectPluginStoreKindDeclarationV1 } from '@happier-dev/protocol/plugins/contributions/storeKinds';
import { readAutomationEligibleEventContributionV1, type AutomationEligibleEventContributionV1 } from '@happier-dev/protocol/plugins/contributions/events';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { derivePluginReactNativeBundleCacheKey } from '@/components/plugins/reactNative/bundleCache';
import { readActionOutputDiagnostic, withActionFailureCauseDiagnostic } from '@happier-dev/protocol/actions/executor/actionFailureDiagnostic';
import { logPluginSurfaceDiagnostic } from '@/components/plugins/shared/pluginSurfaceDiagnosticLog';

import {
    areServerAccountScopesEqual,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import type { PluginHostBundledUiDeclaration } from './bundledPluginUiArtifactInventory';
import { createPluginAccountAvailabilityInitialReadiness, type PluginAccountAvailabilityInitialFailure } from './initialReadiness';
import { retainIfEqual } from '@/sync/domains/state/structuralSharing';
import { replaceAccountUiDeclarationSlice } from './accountUiDeclarationSlice';
import { projectAccountClientEntities } from './accountClientEntities';
export type { PluginHostBundledUiDeclaration } from './bundledPluginUiArtifactInventory';

export type PluginAccountExecutionAdmission = PluginAccountExecutionSelectionV1 | Readonly<{
    kind: 'unavailable';
    code: 'account_availability_not_loaded' | 'account_availability_scope_mismatch' | 'plugin_ui_declaration_pending'
        | PluginAccountAvailabilityInitialFailure['code'];
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
    /** Full discovery facts; first-paint presentation manifests do not prove absent contributors. */
    contributorDeclaration: PluginPortableReleaseManifestV1 | null;
    /** Unavailable source-bound content is settled, but does not prove absent capabilities. */
    declarationState: 'known' | 'preparing' | 'unavailable';
    /** Manifest knowledge alone does not prove projected renderer descriptors. */
    uiDeclarationState: 'known' | 'preparing' | 'unavailable';
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

/**
 * An Account Action's form is the one the daemon projects for its own Actions
 * (`apps/cli/.../normalize/actionInput.ts`): fields completed from the input
 * schema, with the author's localized fields kept for the presenting host.
 */
function projectAccountActionInputHints(action: Readonly<{
    inputHints?: Parameters<typeof normalizePluginActionInputHintsV2>[0];
    inputSchema?: Parameters<typeof normalizePluginActionInputHintsV2>[1];
}>): Readonly<{ inputHints?: ReturnType<typeof overlayPluginActionAuthoredInputHintsV2> }> {
    const completed = normalizePluginActionInputHintsV2(action.inputHints, action.inputSchema);
    return completed ? { inputHints: overlayPluginActionAuthoredInputHintsV2(completed, action.inputHints) } : {};
}

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
            | PluginAccountAvailabilityInitialFailure['code']
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
        sharedRowDestination?: string;
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

export type ExactPluginMaterializations = Readonly<{
    rows: readonly PluginMachineMaterializationV1[];
    inventoryComplete: boolean;
}>;

export type PluginAccountAvailabilityReader = Readonly<{
    /** Opaque current publication identity, scoped to this reader's Account. */
    getObservationSnapshot: (pluginId?: string) => object | null;
    /** Exact supplier slots for a renderer demand, held for the current plugin observation. */
    readExactMaterializations: (pluginId: string, signal: AbortSignal) => Promise<readonly PluginMachineMaterializationV1[]>;
    /** Stable descriptive UI inputs; invocation authority remains a live read below. */
    readUiProjectionInputs: () => PluginAccountUiProjectionInputs | null;
    /** Account custody projects into the existing executable registration owner. */
    readAccountUiProjection: () => PluginUiProjectionModel | null;
    /** Current intent. Null is known absence and undefined means the projection cannot answer. */
    readCurrentAccountIntent: (pluginId: string) => PluginAccountPluginIntentV1 | null | undefined;
    /** Desired Account enablement. Null is not loaded or incomplete. */
    readCurrentAccountEnablement: (pluginId: string) => boolean | null;
    /** Installation enablement for an addressed Machine, or the complete census for automatic selection. */
    readCurrentMachineEnablement: (
        pluginId: string,
        target: Pick<PluginMachineMaterializationV1, 'serverIdentityId' | 'machineId'> | null,
    ) => boolean | null;
    readCurrentAccountExecution: (pluginId: string) => PluginAccountExecutionAdmission;
    /** The same Account-selected Event declaration consumed by trigger admission. */
    readCurrentAutomationEventContribution: (input: Readonly<{
        pluginId: string; version: string; eventLocalId: string; sourceContractVersion?: number;
        machineId?: string; machineInstallationId?: string;
    }>) => AutomationEligibleEventContributionV1 | null;
    /** Demand the exact plugin's Machine bodies through the canonical Availability loader. */
    ensureAutomationEventDeclarations: (input: Readonly<{ pluginId: string; machineId: string }>) => Promise<void>;
    /** Acquires immutable code facts, then re-reads current Account admission. */
    ensureCurrentAccountExecution: (pluginId: string) => Promise<PluginAccountExecutionAdmission>;
    /** Exact target plus its declared suppliers; never a whole-inventory load. */
    ensureAccountTargetDeclarations: (pluginId: string) => Promise<void>;
    /** Current enabled declarations, including descriptive Machine-placed sources. */
    readCurrentAccountExecutionDeclarations: () => readonly Extract<PluginAccountExecutionSelectionV1, { kind: 'available' }>[];
    /** Demand-load exact bundled declarations for an opened contribution family. */
    ensureCurrentAccountExecutionDeclarations: (selection: Readonly<{ family: 'machineProvisioners' | 'deploymentTargets' | 'machineRecipes' }>) => Promise<
        Readonly<{ kind: 'available'; declarations: readonly Extract<PluginAccountExecutionSelectionV1, { kind: 'available' }>[] }>
        | Extract<PluginAccountExecutionAdmission, { kind: 'unavailable' }>>;
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
     * A plugin key selects its facts and targeted contributors, omitting clocks.
     */
    subscribe: (listener: () => void, pluginId?: string) => () => void;
}>;

/** Cursor-free declaration inputs. Observation time is not a declaration revision. */
export type PluginAccountUiProjectionInputs = Readonly<{
    /** Failed initial acquisition is unknown, not a confirmed empty inventory. */
    unavailableReasonCode?: PluginAccountAvailabilityInitialFailure['code'];
    materializations: readonly PluginMachineMaterializationV1[];
    installedPlugins: Extract<PluginAccountInstalledPluginsAdmission, { kind: 'available' }>['plugins'] | undefined;
    /** Machines with a Home inventory report, including reports with no installations. */
    reportedMachines?: readonly Pick<PluginMachineMaterializationSnapshotV1, 'serverIdentityId' | 'machineId'>[];
    accountUiProjection: PluginUiProjectionModel | null;
}>;

export type PluginAccountAvailabilityReaderStore = Readonly<{
    /** Publish a terminal initial read failure, retaining any confirmed same-Account facts. */
    fail: (failure: PluginAccountAvailabilityInitialFailure) => void;
    replace: (input: Readonly<{
        scope: ServerAccountScope;
        snapshot: PluginAccountAvailabilitySnapshot;
        failedPluginIds?: readonly string[];
        intentCensusIncomplete?: boolean;
        initialFailure?: PluginAccountAvailabilityInitialFailure;
        /**
         * The snapshot is a complete row-level read of only these plugins
         * (every current Account Machine, filtered to them). It replaces their
         * rows in the held complete projection and keeps every other plugin's.
         */
        pluginIds?: readonly string[];
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
    /** No complete intent census has yet established omitted plugin identities. */
    intentCensusIncomplete?: boolean;
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
    releasesByPluginId: ReadonlyMap<string, readonly PluginReleaseFactsV1[]>;
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
    previous: PluginMachineMaterializationV1 | undefined,
    declarations: Readonly<{
        manifests: Map<PluginPortableReleaseManifestV1, PluginPortableReleaseManifestV1>;
        uiEntries: Map<NonNullable<PluginMachineMaterializationV1['declaredUiEntries']>, NonNullable<PluginMachineMaterializationV1['declaredUiEntries']>>;
        uiArtifactSets: Map<PluginMachineMaterializationV1['uiArtifacts'], PluginMachineMaterializationV1['uiArtifacts']>;
    }>,
): PluginMachineMaterializationV1 {
    if (previous && retainIfEqual(previous, materialization) === previous) return previous;
    // A decoded list is admitted once, immutable and shared by every Machine row
    // that reported it: retain it once per replacement, never copy it per row.
    const admittedUiArtifacts = isAdmittedPluginMachineUiArtifactSetV1(materialization.uiArtifacts)
        ? declarations.uiArtifactSets.get(materialization.uiArtifacts) ?? declarations.uiArtifactSets.set(materialization.uiArtifacts,
            retainIfEqual(previous?.uiArtifacts, materialization.uiArtifacts)).get(materialization.uiArtifacts)!
        : undefined;
    const manifest = materialization.declaredManifest;
    const uiEntries = materialization.declaredUiEntries;
    if (manifest && !declarations.manifests.has(manifest)) declarations.manifests.set(manifest,
        retainIfEqual(previous?.declaredManifest,
            snapshotDeepDeclaration(manifest)));
    if (uiEntries && !declarations.uiEntries.has(uiEntries)) declarations.uiEntries.set(uiEntries,
        retainIfEqual(previous?.declaredUiEntries,
            snapshotDeepDeclaration(uiEntries)));
    return freezeAvailabilitySnapshotValue({
        ...materialization,
        ...(manifest ? {
            declaredManifest: declarations.manifests.get(manifest)!,
        } : {}),
        ...(uiEntries ? {
            declaredUiEntries: declarations.uiEntries.get(uiEntries)!,
        } : {}),
        uiArtifacts: admittedUiArtifacts ?? (materialization.uiArtifacts === previous?.uiArtifacts ? materialization.uiArtifacts
            : retainIfEqual(previous?.uiArtifacts, freezeAvailabilitySnapshotValue(materialization.uiArtifacts.map((artifact) => (
                freezeAvailabilitySnapshotValue({ ...artifact })
            ))))),
    });
}

/** HTTP admission owns validation; publication only detaches and freezes its typed JSON. */
function snapshotDeepDeclaration<T>(value: T): T {
    if (Array.isArray(value)) return Object.freeze(value.map(child => snapshotDeepDeclaration(child))) as T;
    if (value && typeof value === 'object') return Object.freeze(Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, snapshotDeepDeclaration(child)]),
    )) as T;
    return value;
}

/** Build-owned bundled graphs already have detached ownership; preserve their identity. */
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
        // Declarations are identities here; bodies live in the store's digest-keyed body set.
        ...(response.currentDeclaration === undefined ? {} : {
            currentDeclaration: response.currentDeclaration === null ? null : freezeAvailabilitySnapshotValue({
                declarationDigestSha256: response.currentDeclaration.declarationDigestSha256,
            }),
        }),
        ...(response.machineDeclarations === undefined ? {} : {
            machineDeclarations: freezeAvailabilitySnapshotValue(response.machineDeclarations.map(entry =>
                freezeAvailabilitySnapshotValue({ machineId: entry.machineId, machineInstallationId: entry.machineInstallationId,
                    declaration: freezeAvailabilitySnapshotValue({ declarationDigestSha256: entry.declaration.declarationDigestSha256 }) }))),
        }),
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
    const previousIntents = new Map(previous?.intentReads.map(row => [row.pluginId, row] as const));
    // HTTP admission has validated each declaration. Share its detached,
    // immutable snapshot across inventory views and Machine rows.
    // These maps live only for this replacement; they retain no retired roots.
    const manifests = new Map<PluginPortableReleaseManifestV1, PluginPortableReleaseManifestV1>();
    const uiEntries = new Map<NonNullable<PluginMachineMaterializationV1['declaredUiEntries']>, NonNullable<PluginMachineMaterializationV1['declaredUiEntries']>>();
    for (const row of previous?.materializations ?? []) {
        if (row.declaredManifest) manifests.set(row.declaredManifest, row.declaredManifest);
        if (row.declaredUiEntries) uiEntries.set(row.declaredUiEntries, row.declaredUiEntries);
    }
    // The flat census and per-Machine views can carry the same ingress row.
    // Admit it once, then carry that owned value into both projections.
    const admittedRows = new Map<PluginMachineMaterializationV1, PluginMachineMaterializationV1>();
    const uiArtifactSets = new Map<PluginMachineMaterializationV1['uiArtifacts'], PluginMachineMaterializationV1['uiArtifacts']>();
    const clone = (row: PluginMachineMaterializationV1) => {
        const admitted = admittedRows.get(row);
        if (admitted) return admitted;
        const owned = cloneMaterialization(row, previousMaterializations.get(materializationLookupKey(row)), { manifests, uiEntries, uiArtifactSets });
        admittedRows.set(row, owned);
        return owned;
    };
    return freezeAvailabilitySnapshotValue({
        availabilityCursor: snapshot.availabilityCursor,
        inventoryComplete: snapshot.inventoryComplete !== false,
        releases: Object.freeze((snapshot.releases ?? []).map((release, index) => {
            const held = previous?.releases?.[index];
            return held && retainIfEqual(held, release) === held ? held : snapshotPluginReleaseFactsV1(release);
        })),
        intentReads: freezeAvailabilitySnapshotValue(snapshot.intentReads.map((projection) => {
            const held = previousIntents.get(projection.pluginId);
            if (held && retainIfEqual(held, projection) === held) return held;
            return freezeAvailabilitySnapshotValue({
                pluginId: projection.pluginId,
                response: snapshotIntentReadResponse(projection.response),
            });
        })),
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

function compareMaterializationRows(left: PluginMachineMaterializationV1, right: PluginMachineMaterializationV1): number {
    if (left.pluginId !== right.pluginId) return left.pluginId < right.pluginId ? -1 : 1;
    return left.materializationId < right.materializationId ? -1 : left.materializationId > right.materializationId ? 1 : 0;
}

/**
 * Merges a complete row-level read of `pluginIds` into the held complete
 * inventory. The read lists every current Account Machine (filtered to those
 * plugins), so a held Machine it omits has left the Account inventory, exactly
 * as a complete read would show. Other plugins' rows are kept as last-good;
 * their own Availability hints replace them.
 */
function mergeNamedPluginInventory(
    previous: PluginAccountAvailabilitySnapshot | null,
    incoming: PluginAccountAvailabilitySnapshot,
    pluginIds: ReadonlySet<string>,
): Readonly<{
    snapshots: readonly PluginMachineMaterializationSnapshotV1[];
    materializations: readonly PluginMachineMaterializationV1[];
    releases: readonly PluginReleaseFactsV1[];
}> {
    if (!previous || previous.inventoryComplete === false || incoming.inventoryComplete === false) {
        throw new Error('Plugin Availability row-level read needs a complete projection to merge into.');
    }
    const machineKey = (entry: PluginMachineMaterializationSnapshotV1) => `${entry.serverIdentityId}\0${entry.machineId}`;
    const incomingByMachine = new Map(incoming.snapshots.map(entry => [machineKey(entry), entry] as const));
    const snapshots: PluginMachineMaterializationSnapshotV1[] = [];
    for (const held of previous.snapshots) {
        const named = incomingByMachine.get(machineKey(held));
        if (!named) continue;
        incomingByMachine.delete(machineKey(held));
        const kept = held.materializations.filter(row => !pluginIds.has(row.pluginId));
        const read = named.materializations.filter(row => pluginIds.has(row.pluginId));
        snapshots.push(kept.length === held.materializations.length && read.length === 0 ? held
            : Object.freeze({ ...held, materializations: Object.freeze([...kept, ...read].sort(compareMaterializationRows)) }));
    }
    // A Machine new to the projection carries only the named plugins' rows;
    // its other plugins arrive with their own Availability hints.
    for (const added of incomingByMachine.values()) {
        snapshots.push(Object.freeze({ ...added,
            materializations: Object.freeze(added.materializations.filter(row => pluginIds.has(row.pluginId))) }));
    }
    const materializations = snapshots.flatMap(entry => entry.materializations);
    const releases = [...(previous.releases ?? []).filter(release => !pluginIds.has(release.ref.pluginId)),
        ...(incoming.releases ?? []).filter(release => pluginIds.has(release.ref.pluginId))]
        .filter(release => materializations.some(row => isExactPluginMachineMaterializationReleaseCorrespondenceV1(row, release)));
    return Object.freeze({ snapshots, materializations, releases });
}

/**
 * Availability facts carry identity-bound projection proofs: equal data keeps its previous value and
 * anything else is replaced whole (`retainIfEqual`), never rebuilt. Local edits to the ordered
 * snapshot retain the unchanged rows beside them.
 */
function retainAvailabilityRows<T>(previous: readonly T[] | undefined, next: readonly T[]): readonly T[] {
    if (!previous) return next;
    const rows = next.map((row, index) => retainIfEqual(previous[index], row));
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

// Both unavailable answers carry only their reason. Keep them stable across
// reads so origin demand can distinguish Account readiness from a re-render.
const MATERIALIZATION_ADMISSION_NOT_LOADED = Object.freeze({ kind: 'unavailable', code: 'account_availability_not_loaded' });
const MATERIALIZATION_ADMISSION_SCOPE_MISMATCH = Object.freeze({ kind: 'unavailable', code: 'account_availability_scope_mismatch' });

function readMaterializationAdmission(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
): PluginMachineMaterializationAdmission {
    if (!state) {
        return MATERIALIZATION_ADMISSION_NOT_LOADED;
    }
    const snapshot = readProjectionForScope(state, scope);
    if (!snapshot) {
        return MATERIALIZATION_ADMISSION_SCOPE_MISMATCH;
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

/** Declaration need is descriptive; only the selected runtime grants execution. */
function readManifestDeclaredExecution(manifest: PluginPortableReleaseManifestV1) {
    return {
        daemonActions: manifest.contributes.actions?.some(action => action.execution.target === 'daemon') === true,
        contributionPoints: (manifest.contributes.pluginContributionPoints?.length ?? 0) > 0,
    };
}

function readInstalledPluginsAdmission(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    admitted = readMaterializationAdmission(state, scope),
    previous?: Readonly<{ state: AvailabilityProjectionState; installed: PluginAccountInstalledPluginsAdmission }>,
): PluginAccountInstalledPluginsAdmission {
    if (admitted.kind === 'unavailable') return admitted;
    const snapshot = state!.snapshot;
    return retainIfEqual(previous?.installed, Object.freeze({
        kind: 'available',
        availabilityCursor: snapshot.availabilityCursor,
        completeness: snapshot.inventoryComplete === false ? 'incomplete' : 'complete',
        plugins: readInstalledPluginRows(state!, scope, admitted.materializations,
            previous?.installed.kind === 'available' ? previous.installed.plugins : [], previous?.state),
    }));
}

type InstalledPluginRows = Extract<PluginAccountInstalledPluginsAdmission, { kind: 'available' }>['plugins'];

function projectInstalledActionTitles(actions: PluginHostBundledUiDeclaration['actionTitles']) {
    return actions?.length
        ? { actionTitlesById: Object.freeze(Object.fromEntries(actions.map(({ id, title }) => [id, title]))) }
        : {};
}

function readBundledActionTitles(bundle: PluginHostBundledUiDeclaration | undefined) {
    return bundle?.normalizedManifest ? bundle.normalizedManifest.contributes.actions : bundle?.actionTitles;
}

/** The same declaration projection serves census ingestion and a single bundle's fulfillment. */
function readInstalledPluginRows(state: AvailabilityProjectionState, scope: ServerAccountScope,
    materializations: readonly PluginMachineMaterializationV1[], previous: InstalledPluginRows,
    previousState?: AvailabilityProjectionState): InstalledPluginRows {
    const previousInstallations = new Map(previous.flatMap(plugin => plugin.installations.map(installation =>
        [materializationLookupKey(installation.materialization), installation] as const)));
    const previousPlugins = new Map(previous.map(plugin => [plugin.pluginId, plugin] as const));
    const byPluginId = new Map<string, PluginAccountInstalledPluginInstallation[]>();
    const releaseInputs = new Map<string, Readonly<{ releases: readonly PluginReleaseFactsV1[]; unchanged: boolean }>>();
    for (const materialization of materializations) {
        const { pluginId } = materialization;
        let input = releaseInputs.get(pluginId);
        if (!input) {
            const censusReleases = state.releasesByPluginId.get(pluginId) ?? [];
            const intents = state.intentReadsByPluginId.get(pluginId) ?? [];
            const oldReleases = previousState?.releasesByPluginId.get(pluginId) ?? [];
            const oldIntents = previousState?.intentReadsByPluginId.get(pluginId) ?? [];
            input = {
                releases: [...censusReleases, ...intents.flatMap(({ response }) => response.release ? [response.release] : [])],
                unchanged: previousState !== undefined
                    && previousState.bundledUiByPluginId.get(pluginId) === state.bundledUiByPluginId.get(pluginId)
                    && previousState.retiredPluginIds?.includes(pluginId) === state.retiredPluginIds?.includes(pluginId)
                    && oldReleases.length === censusReleases.length && oldReleases.every((release, index) => release === censusReleases[index])
                    && oldIntents.length === intents.length && oldIntents.every(({ response }, index) =>
                        response.release === intents[index]!.response.release
                        && sameStrictJsonValue(response.intent, intents[index]!.response.intent)),
            };
            releaseInputs.set(pluginId, input);
        }
        const installations = byPluginId.get(pluginId) ?? [];
        byPluginId.set(pluginId, installations);
        const key = materializationLookupKey(materialization);
        const incumbent = previousInstallations.get(key);
        // A duplicate identity can change installed-release admission even when
        // this row survives the census. A unique held row shares its exact input.
        if (input.unchanged && incumbent?.materialization === materialization
            && (!materialization.portableRelease || (state.materializationsByIdentity.get(key)?.length === 1
                && previousState?.materializationsByIdentity.get(key)?.length === 1))) {
            installations.push(incumbent);
            continue;
        }
        const releases = input.releases.filter(release =>
            isExactPluginMachineMaterializationReleaseCorrespondenceV1(materialization, release));
        const uniqueReleases = new Map(releases.map(release => [release.archiveDigestSha256, release]));
        const release = uniqueReleases.size === 1 ? [...uniqueReleases.values()][0]! : null;
        // Machine census rows omit live manifests. The app's admitted bundled
        // declaration supplies presentation for the same installed coordinate.
        const bundles = state!.bundledUiByPluginId.get(materialization.pluginId) ?? [];
        const bundle = materialization.sourceClass === 'bundledFirstParty' && bundles.length === 1
            && bundles[0]!.pluginVersion === materialization.version ? bundles[0] : undefined;
        const contributorDeclaration = release?.normalizedManifest ?? materialization.declaredManifest
            ?? bundle?.normalizedManifest ?? null;
        const declaration = contributorDeclaration ?? bundle?.presentationManifest ?? null;
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
            const subjectKinds = declaration ? (declaration.contributes?.subjectKinds ?? []).map(definition =>
                projectPluginSubjectKindDeclarationV1({ pluginId: materialization.pluginId,
                    pluginVersion: declaration.version, definition })) : [];
            const storeKinds = declaration ? (declaration.contributes?.storeKinds ?? []).map(definition =>
                projectPluginStoreKindDeclarationV1({ pluginId: materialization.pluginId,
                    pluginVersion: declaration.version, definition })) : [];
            uiModel = normalizePluginInstalledUiDeclarations(declaredUiEntries ?? {}, undefined, {
                id: materialization.pluginId,
                displayName: declaration ? resolvePluginLocalizedStringV2Text(declaration.displayName) : materialization.pluginId,
                version: materialization.version,
                enabled: materialization.enabled,
                source: { kind: materialization.sourceClass, locator: materialization.materializationId },
                ...(declaration?.executionTarget ? { executionTarget: declaration.executionTarget } : {}),
                ...(declaration ? { declaredExecution: readManifestDeclaredExecution(declaration) } : {}),
                ...projectInstalledActionTitles(contributorDeclaration
                    ? contributorDeclaration.contributes.actions : bundle?.actionTitles),
            }, registrySources, skills, storeKinds, subjectKinds);
            // A new declaration (a full manifest replacing its summary) often
            // carries the same UI facts; keep the incumbent model whole then.
            uiModel = retainIfEqual(incumbent?.uiModel, preparePluginUiProjectionOrigins(uiModel));
        }
        // Portable declarations can arrive from the immutable release reader.
        // Release-less content stays with the live source: no census producer
        // will complete preparation of an omitted manifest or UI declaration.
        const missingDeclarationState = materialization.portableRelease ? 'preparing' : 'unavailable';
        installations.push(retainIfEqual(incumbent, Object.freeze({
            materialization,
            declaration,
            contributorDeclaration,
            declarationState: declaration ? 'known' : missingDeclarationState,
            uiDeclarationState: materialization.declaredUiEntries !== undefined || release ? 'known' : missingDeclarationState,
            release,
            execution: classifyMaterializationRelease(state, scope, materialization),
            uiModel,
        })));
    }
    const plugins = [...byPluginId].sort(([a], [b]) => compareCodeUnits(a, b)).map(([pluginId, installations]) => retainIfEqual(previousPlugins.get(pluginId), Object.freeze({
        pluginId,
        installations: Object.freeze(installations),
    })));
    // A cursor-only republication keeps the list, so consumers' per-list facts still hold.
    return plugins.length === previous.length && plugins.every((plugin, index) => plugin === previous[index])
        ? previous : Object.freeze(plugins);
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
        code: Extract<PluginAccountAvailabilityReleaseSelectionAdmission, { kind: 'unavailable' }>['code'];
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
    // A Data-only declaration claim selects no Account release. Exact installed
    // custody remains authoritative; disabled or version-selected intent does not.
    if (intents.length !== 1) return null;
    const intent = intents[0]!.response.intent;
    if (intent !== null && (!intent.enabled || intent.desiredVersion !== null)) return null;
    const rows = state!.materializationsByIdentity.get(materializationLookupKey({
        ...origin.materializationRef, serverIdentityId: origin.serverIdentityId,
    })) ?? [];
    if (rows.length !== 1) return null;
    const materialization = rows[0]!;
    if (!materialization.enabled || materialization.trustState !== 'trusted' || !materialization.portableRelease) return null;
    const releases = (state!.releasesByPluginId.get(pluginId) ?? []).filter(release =>
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
    accountPresentation: BundledAccountExecution | null;
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
        const presentationManifest = sourceManifest ?? declaration.presentationManifest ?? null;
        // Serialized compiler output needs immutable schema-byte ownership.
        // Executable point parsers are acquired only by their demand-time reader.
        const contributes = sourceManifest ? preparePluginContributionPointDeclarationsV1(sourceManifest.contributes) : null;
        const manifest = sourceManifest && contributes && contributes !== sourceManifest.contributes
            ? freezeDeepDeclaration({ ...sourceManifest, contributes }) : sourceManifest;
        const artifactGraphs = declaration.artifactGraphs ?? Object.freeze([]);
        const accountActionArtifactGraphs = distinctAccountActionArtifactGraphs(artifactGraphs);
        const accountExecution = manifest ? createPluginAccountBundledSelectionV1({ packageName: declaration.packageName, manifest }) : null;
        const accountPresentation = presentationManifest
            ? createPluginAccountBundledSelectionV1({ packageName: declaration.packageName, manifest: presentationManifest }) : null;
        const entriesById = declaration.entriesById;
        const declaredArtifactGraphs = Object.values(entriesById).flatMap(entry => {
            const graph = entry.artifactGraph as PluginUiArtifactsManifestEntryV2 | undefined;
            return typeof entry.contributionId === 'string' && graph
                ? [Object.freeze({ contributionId: entry.contributionId, graph })] : [];
        });
        // The catalog owns executable slot coordinates. Client contributions
        // borrow Account custody too; their UI realm does not require a Machine.
        if (accountPresentation && presentationManifest) {
            const slots = [...derivePluginAccountExecutionArtifactSlots(presentationManifest.contributes)
                .map(({ contributionId, registrationRight }) => ({ contributionId, reference: registrationRight.target })),
                ...derivePluginContributionRegistrationRights(presentationManifest.contributes).flatMap(right =>
                    right.target.realm === 'client'
                        ? [{ contributionId: right.family === 'actions' ? right.localId : `${right.family}/${right.localId}`, reference: right.target }] : [])];
            for (const { contributionId, reference } of slots) {
                declaredArtifactGraphs.push(...accountActionArtifactGraphs.flatMap(graph => graph.tier === 'reactNative'
                    && graph.artifactId === reference.artifactId && graph.executable.exports.includes(reference.exportName)
                    ? [Object.freeze({ contributionId, graph })] : []));
            }
        }
        const artifactGraphsByContributionId = new Map([...indexAvailabilityRows(declaredArtifactGraphs, entry => entry.contributionId)]
            .map(([id, entries]) => [id, Object.freeze(entries.map(entry => entry.graph))]));
        return Object.freeze({
            ...declaration,
            entriesById,
            artifactGraphs,
            accountActionArtifactGraphs,
            artifactGraphsByContributionId,
            ...(manifest ? { normalizedManifest: manifest } : {}),
            accountExecution,
            accountPresentation,
        });
    }));
}

function readAccountExecutionSelection(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    pluginId: string,
    presentation = false,
): PluginAccountExecutionAdmission {
    const snapshot = readProjectionForScope(state, scope);
    if (!snapshot) return Object.freeze({ kind: 'unavailable', code: state
        ? 'account_availability_scope_mismatch' : 'account_availability_not_loaded' });
    if (state?.retiredPluginIds?.includes(pluginId)) return Object.freeze({ kind: 'unavailable', code: 'plugin_account_execution_unavailable' });
    const reads = state!.intentReadsByPluginId.get(pluginId) ?? [];
    if (reads.length > 1) return Object.freeze({ kind: 'unavailable', code: 'plugin_release_unavailable' });
    const bundles = state!.bundledUiByPluginId.get(pluginId) ?? [];
    const bundle = bundles.length === 1 ? bundles[0] : undefined;
    const bundled = presentation ? bundle?.accountPresentation : bundle?.accountExecution;
    const selected = resolvePluginAccountExecutionSelectionV1({ pluginId, intentRead: reads[0]?.response ?? null,
        ...(bundled ? { bundled } : {}),
    });
    return selected.kind === 'unavailable' && selected.code === 'plugin_account_execution_unavailable'
        && !presentation && bundle?.loadDeclaration && !bundle.accountExecution
        ? Object.freeze({ kind: 'unavailable', code: 'plugin_ui_declaration_pending' }) : selected;
}

function readAccountExecutionSelections(
    state: AvailabilityProjectionState | null,
    scope: ServerAccountScope,
    hostBundledUi: readonly PreparedBundledUiDeclaration[],
    presentation = false,
): readonly Extract<PluginAccountExecutionSelectionV1, { kind: 'available' }>[] {
    const snapshot = readProjectionForScope(state, scope);
    if (!snapshot) return Object.freeze([]);
    const pluginIds = new Set([...snapshot.intentReads.map(row => row.pluginId), ...hostBundledUi.map(row => row.pluginId)]);
    return Object.freeze([...pluginIds].sort().flatMap(pluginId => {
        const selected = readAccountExecutionSelection(state, scope, pluginId, presentation);
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
        manifest?: PluginPortableReleaseManifestV1;
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
            manifest: release.release.normalizedManifest,
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
    const manifest = bundle ? bundle.normalizedManifest : current.manifest;
    const sharedRowDestination = manifest?.contributes?.accountCollections?.find(
        declaration => declaration.id === ref.collectionId,
    )?.sharedRowDestination;
    // Data resolves compatibility and read/write access for this exact ref.
    // Availability never substitutes the current writer's digest for a caller.
    return Object.freeze({
        kind: 'available',
        availabilityCursor: current.availabilityCursor,
        ref: Object.freeze({ ...ref }),
        ...(sharedRowDestination === undefined ? {} : { sharedRowDestination }),
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
        const accountKv = readCurrentAccountKvCapabilityAdmission(state, scope, input);
        if (accountKv.kind === 'available') return accountKv;
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
        const selected = readAccountExecutionSelection(state, scope, input.pluginId, true);
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
    if (current.kind === 'available') {
        return Object.freeze({
            kind: 'available',
            availabilityCursor: current.availabilityCursor,
            declaration: current.release.normalizedManifest,
        });
    }
    if (current.code === 'artifact_not_current') {
        const snapshot = readProjectionForScope(state, scope);
        const selected = readAccountExecutionSelection(state, scope, input.pluginId);
        if (snapshot && selected.kind === 'available' && selected.sourceCustody.kind === 'bundled_first_party') {
            return Object.freeze({
                kind: 'available',
                availabilityCursor: snapshot.availabilityCursor,
                declaration: selected.manifest,
            });
        }
    }
    return Object.freeze({ kind: 'unavailable', code: current.code });
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
    // Inventory arrival order is not a UI fact. Match by the complete source
    // identity so insertion, removal and reordered reports keep peer rows.
    const preceding = new Map(previous?.map(row => [materializationLookupKey(row), row] as const));
    const rows = next.map(row => {
        const key = materializationLookupKey(row);
        const before = preceding.get(key);
        return { key, row: before && samePluginUiMaterializationFacts(before, row) ? before : row };
    }).sort((left, right) => compareCodeUnits(left.key, right.key)).map(({ row }) => row);
    return previous?.length === rows.length && rows.every((row, index) => row === previous[index])
        ? previous : Object.freeze(rows);
}

/** Reuse ingestion-owned declaration/model references; never compare manifests again here. */
function retainUiInstalledPlugins(previous: PluginAccountUiProjectionInputs['installedPlugins'],
    next: PluginAccountUiProjectionInputs['installedPlugins'],
    previousAdmission: PluginAccountUiProjectionInputs['installedPlugins']): PluginAccountUiProjectionInputs['installedPlugins'] {
    if (!next) return next;
    if (next === previousAdmission) return previous;
    const preceding = new Map(previous?.map(plugin => [plugin.pluginId, plugin] as const));
    const admitted = new Map(previousAdmission?.map(plugin => [plugin.pluginId, plugin] as const));
    const plugins = next.map(plugin => {
        const prior = preceding.get(plugin.pluginId);
        if (prior && admitted.get(plugin.pluginId) === plugin) return prior;
        const previousInstallations = new Map(prior?.installations.map(installation =>
            [materializationLookupKey(installation.materialization), installation] as const));
        const installations = plugin.installations.map(installation => {
            const key = materializationLookupKey(installation.materialization);
            const before = previousInstallations.get(key);
            const execution = retainIfEqual(before?.execution, installation.execution);
            const unchanged = before && samePluginUiMaterializationFacts(before.materialization, installation.materialization)
                && before.declaration === installation.declaration && before.contributorDeclaration === installation.contributorDeclaration
                && before.release === installation.release
                && before.declarationState === installation.declarationState && before.uiDeclarationState === installation.uiDeclarationState
                && before.uiModel === installation.uiModel && before.execution === execution;
            return { key, installation: unchanged ? before : installation };
        }).sort((left, right) => compareCodeUnits(left.key, right.key)).map(({ installation }) => installation);
        return prior?.installations.length === installations.length
            && installations.every((installation, rowIndex) => installation === prior.installations[rowIndex])
            ? prior : Object.freeze({ ...plugin, installations: Object.freeze(installations) });
    });
    return previous?.length === plugins.length && plugins.every((plugin, index) => plugin === previous[index])
        ? previous : Object.freeze(plugins);
}

/** Share unchanged family rows once, when this descriptive model is published. Rows are identity-bound (projection proofs), so each is kept or replaced whole, never rebuilt. */
function retainAccountUiProjectionRows(previous: PluginUiProjectionModel | null | undefined, next: PluginUiProjectionModel | null): PluginUiProjectionModel | null {
    if (!previous || !next) return next;
    const families = Object.fromEntries(Object.entries(next).map(([key, value]) => {
        const before: unknown = previous[key as keyof PluginUiProjectionModel];
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || !before || typeof before !== 'object' || Array.isArray(before)) {
            return [key, retainIfEqual(before, value)];
        }
        const previousRows = before as Readonly<Record<string, unknown>>;
        const rows = Object.freeze(Object.fromEntries(Object.entries(value).map(([id, row]) =>
            [id, retainIfEqual(previousRows[id], row)])));
        return [key, retainIfEqual(before, rows)];
    }));
    return retainIfEqual(previous, Object.freeze({ ...next, ...families }));
}

type AvailabilityObservation = Readonly<{
    value: Readonly<{
        scope: ServerAccountScope;
        inventoryComplete: boolean;
        intentCensusIncomplete: boolean;
        retired: boolean;
        accountDeclarations: readonly (Pick<Extract<PluginAccountExecutionSelectionV1, { kind: 'available' }>,
            'manifest' | 'custodyId' | 'sourceCustody'> & Readonly<{ bundledExecutionReady: boolean }>)[];
        intentReads: readonly Readonly<{ pluginId: string; response: Omit<PluginAccountAvailabilityIntentReadProjection['response'], 'availabilityCursor'> }>[];
        materializations: readonly Omit<PluginMachineMaterializationV1, 'observedAt'>[];
        releases: readonly PluginReleaseFactsV1[];
        machines: readonly Readonly<{ serverIdentityId: string; machineId: string }>[];
        machineMaterializations: readonly Readonly<{ machineIndex: number;
            materializations: readonly Omit<PluginMachineMaterializationV1, 'observedAt'>[] }>[];
    }>;
    token: object;
}>;

type AvailabilityObservations = Readonly<{
    all: object;
    empty: AvailabilityObservation;
    byPluginId: ReadonlyMap<string, AvailabilityObservation>;
}>;

function accountDeclarationObservation(state: AvailabilityProjectionState,
    selected: AvailabilityAccountUiProjection['selections'][number]): AvailabilityObservation['value']['accountDeclarations'][number] {
    return Object.freeze({ manifest: selected.manifest, custodyId: selected.custodyId,
        sourceCustody: selected.sourceCustody,
        bundledExecutionReady: state.bundledUiByPluginId.get(selected.manifest.id)?.some(bundle => bundle.accountExecution !== null) ?? false });
}

/** Bundle acquisition changes Account declarations, never the already admitted Machine census. */
function deriveDeclarationAvailabilityObservations(state: AvailabilityProjectionState, pluginId: string,
    previousSelections: AvailabilityAccountUiProjection['selections'], selections: AvailabilityAccountUiProjection['selections'],
    previous: AvailabilityObservations): AvailabilityObservations {
    const before = previousSelections.find(selected => selected.manifest.id === pluginId);
    const selected = selections.find(selected => selected.manifest.id === pluginId);
    const targets = (selection: typeof selected) => selection
        ? [pluginId, ...selection.manifest.contributes.targetedPluginContributions.map(contribution => contribution.target.pluginId)] : [];
    const nextTargets = new Set(targets(selected));
    const affected = new Set([...targets(before), ...nextTargets]);
    const declaration = selected ? accountDeclarationObservation(state, selected) : undefined;
    const byPluginId = new Map(previous.byPluginId);
    let changed = false;
    for (const target of affected) {
        const prior = previous.byPluginId.get(target) ?? previous.empty;
        const accountDeclarations = Object.freeze([
            ...prior.value.accountDeclarations.filter(row => row.manifest.id !== pluginId),
            ...(declaration && nextTargets.has(target) ? [declaration] : []),
        ].sort((left, right) => compareCodeUnits(left.manifest.id, right.manifest.id)));
        if (sameStrictJsonValue(prior.value.accountDeclarations, accountDeclarations)) continue;
        changed = true;
        if (accountDeclarations.length === 0 && !prior.value.retired && prior.value.intentReads.length === 0
            && prior.value.materializations.length === 0 && prior.value.releases.length === 0) {
            byPluginId.delete(target);
        } else {
            byPluginId.set(target, Object.freeze({ value: Object.freeze({ ...prior.value, accountDeclarations }), token: Object.freeze({}) }));
        }
    }
    return changed ? Object.freeze({ ...previous, all: Object.freeze({}), byPluginId }) : previous;
}

function deriveAvailabilityObservations(state: AvailabilityProjectionState,
    accountSelections: AvailabilityAccountUiProjection['selections'], installed: PluginAccountInstalledPluginsAdmission,
    previous?: AvailabilityObservations,
    previousCursor?: number): AvailabilityObservations {
    const { snapshot } = state;
    const intents = state.intentReadsByPluginId;
    const materializations = indexAvailabilityRows(snapshot.materializations, row => row.pluginId);
    const targetedMaterializations = new Map<string, PluginMachineMaterializationV1[]>();
    const accountDeclarations = new Map<string, AvailabilityObservation['value']['accountDeclarations'][number][]>();
    for (const selected of accountSelections) {
        const declaration = accountDeclarationObservation(state, selected);
        const targets = new Set([selected.manifest.id,
            ...selected.manifest.contributes.targetedPluginContributions.map(contribution => contribution.target.pluginId)]);
        for (const target of targets) {
            const rows = accountDeclarations.get(target);
            if (rows) rows.push(declaration); else accountDeclarations.set(target, [declaration]);
        }
    }
    for (const installation of installed.kind === 'available' ? installed.plugins.flatMap(plugin => plugin.installations) : []) {
        const { materialization, contributorDeclaration: declaration } = installation;
        const targets = new Set(declaration?.contributes.targetedPluginContributions.map(contribution => contribution.target.pluginId));
        // The observation carries the resolved declaration only as a change fact;
        // the Machine census and execution authority remain unchanged.
        const row = declaration ? { ...materialization, declaredManifest: declaration } : materialization;
        for (const target of targets) {
            if (target === row.pluginId) continue;
            const rows = targetedMaterializations.get(target);
            if (rows) rows.push(row); else targetedMaterializations.set(target, [row]);
        }
    }
    const releases = state.releasesByPluginId;
    const retired = new Set(state.retiredPluginIds);
    const observe = (value: AvailabilityObservation['value'], prior?: AvailabilityObservation): AvailabilityObservation =>
        prior && sameStrictJsonValue(prior.value, value) ? prior : Object.freeze({ value, token: Object.freeze({}) });
    // A plugin's observation names only the facts that plugin's consumers present:
    // its own rows and contributors targeting it (observation time is a clock,
    // not a fact). Unrelated peer plugins' rows and clocks never wake it.
    const unclocked = (rows: readonly PluginMachineMaterializationV1[] | undefined) =>
        Object.freeze((rows ?? []).map(({ observedAt: _observedAt, ...facts }) => facts));
    // Every intent read is stamped with the Account-wide cursor it was read at. That stamp advances
    // for all plugins whenever anything in the Account changes, so it is a clock, not a plugin fact.
    const unstamped = (rows: readonly PluginAccountAvailabilityIntentReadProjection[] | undefined) =>
        Object.freeze((rows ?? []).map(({ response: { availabilityCursor: _cursor, ...response }, ...row }) =>
            Object.freeze({ ...row, response: Object.freeze(response) })));
    // Every plugin observes the same ordered Machine census. Only Machines
    // with that plugin's rows supply a plugin-specific observation.
    const machines = retainAvailabilityRows(previous?.empty.value.machines,
        Object.freeze(snapshot.snapshots.map(({ serverIdentityId, machineId }) => Object.freeze({ serverIdentityId, machineId }))));
    const byPluginAndMachine = new Map<string, Map<number, PluginMachineMaterializationV1[]>>();
    snapshot.snapshots.forEach((machine, machineIndex) => {
        for (const row of machine.materializations) {
            let byMachine = byPluginAndMachine.get(row.pluginId);
            if (!byMachine) { byMachine = new Map(); byPluginAndMachine.set(row.pluginId, byMachine); }
            const rows = byMachine.get(machineIndex);
            if (rows) rows.push(row);
            else byMachine.set(machineIndex, [row]);
        }
    });
    const empty = observe(Object.freeze({ scope: state.scope, inventoryComplete: snapshot.inventoryComplete !== false,
        intentCensusIncomplete: state.intentCensusIncomplete === true,
        retired: false, accountDeclarations: Object.freeze([]), intentReads: Object.freeze([]), materializations: Object.freeze([]),
        releases: Object.freeze([]), machines, machineMaterializations: Object.freeze([]) }), previous?.empty);
    const byPluginId = new Map<string, AvailabilityObservation>();
    for (const pluginId of new Set([...intents.keys(), ...materializations.keys(), ...targetedMaterializations.keys(),
        ...accountDeclarations.keys(), ...releases.keys(), ...retired])) {
        byPluginId.set(pluginId, observe(Object.freeze({ ...empty.value,
            retired: retired.has(pluginId),
            accountDeclarations: Object.freeze(accountDeclarations.get(pluginId) ?? []),
            intentReads: unstamped(intents.get(pluginId)),
            materializations: unclocked([...(materializations.get(pluginId) ?? []), ...(targetedMaterializations.get(pluginId) ?? [])]),
            releases: Object.freeze(releases.get(pluginId) ?? []),
            machineMaterializations: Object.freeze([...(byPluginAndMachine.get(pluginId) ?? [])].map(([machineIndex, rows]) =>
                Object.freeze({ machineIndex, materializations: unclocked(rows) }))),
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
}>, state: AvailabilityProjectionState, previous?: AvailabilityAccountUiProjection, pluginId?: string): AvailabilityAccountUiProjection {
    // Declaration fulfillment already names the changed input. Keep census admission
    // and sorting at snapshot publication; derive only this plugin's contribution rows.
    const candidates = pluginId === undefined ? input.hostBundledUi : state.bundledUiByPluginId.get(pluginId) ?? [];
    const bundles = candidates.filter(bundle => readCurrentHostBundle(state, input.scope, candidates, bundle.pluginId));
    const selection = pluginId === undefined ? undefined : readAccountExecutionSelection(state, input.scope, pluginId, true);
    const selections = selection ? selection.kind === 'available' ? [selection] : []
        : readAccountExecutionSelections(state, input.scope, input.hostBundledUi, true);
    if (previous?.bundles?.length === bundles.length
        && bundles.every((bundle, index) => bundle === previous?.bundles![index])
        && sameStrictJsonValue(previous?.selections, selections)) {
        return { bundles, selections, model: previous?.model ?? null };
    }
    const entries = Object.assign({}, ...bundles.map(bundle => bundle.entriesById),
        ...selections.map(selected => {
            const declarations = selected.release ? projectPluginPortableUiDeclarationsV1(
                selected.manifest, accountActionArtifactGraphs(selected, candidates),
            ) : bundles.find(bundle => bundle.pluginId === selected.manifest.id)?.entriesById ?? {};
            return selected.release
                ? declarations
                : Object.fromEntries(Object.entries(declarations).filter(([, entry]) => entry.contributionKind === 'uiRenderer'
                    || entry.contributionKind === 'translations'));
        }));
    const accountUiOrigins = new Map(selections.map(({ manifest, custodyId, sourceCustody }) => [manifest.id,
        Object.freeze({ ...input.scope, custodyId, sourceCustody }),
    ] as const));
    const subjectKinds: Record<string, PluginUiProjectionModel['subjectKindsById'][string]> = {};
    const actions: Record<string, PluginUiActionProjection> = {};
    const resources: Record<string, PluginUiProjectionModel['resourcesById'][string]> = {};
    const workItems: Record<string, PluginUiProjectionModel['workItemsById'][string]> = {};
    const dragSources: Record<string, PluginUiProjectionModel['dragSourcesById'][string]> = {};
    const dropTargets: Record<string, PluginUiProjectionModel['dropTargetsById'][string]> = {};
    const connectedAccountDescriptors: Record<string, NonNullable<PluginUiProjectionModel['connectedAccountDescriptorsById']>[string]> = {};
    const accountAgents = selections.flatMap(({ manifest }) => (manifest.contributes.agents ?? []).map(agent => ({
        identity: { pluginId: manifest.id, localId: agent.id }, title: resolvePluginLocalizedStringV2Text(agent.title),
        providerRequirements: agent.providerRequirements,
        connectedAccounts: agent.connectedAccounts?.map(purpose => ({
            service: qualifyPluginContributionReferenceV1(purpose.service, manifest.id),
        })),
    })));
    for (const selected of selections) {
        const { manifest, custodyId } = selected;
        const hostAccountOrigin = accountUiOrigins.get(manifest.id)!;
        for (const definition of manifest.contributes.subjectKinds) {
            const entry = projectPluginSubjectKindDeclarationV1({ pluginId: manifest.id, pluginVersion: manifest.version, definition });
            subjectKinds[entry.id] = Object.freeze({ ...entry, occurrenceId: custodyId });
        }
        const graphs = accountActionArtifactGraphs(selected, candidates);
        const projectAccountArtifact = (contributionId: string, executable: Readonly<{ artifactId: string; exportName: string }>) => {
            const matching = graphs.filter(graph => graph.tier === 'reactNative' && graph.artifactId === executable.artifactId
                && graph.executable.exports.includes(executable.exportName));
            const graph = matching.length === 1 ? matching[0] : undefined;
            const compatible = graph !== undefined && graph.tier === 'reactNative' && isPluginUiExecutableArtifactHostCompatibleV1(graph);
            if (graph) {
                const entry = projectPluginReactNativeArtifactEntryV1({ pluginId: manifest.id, pluginVersion: manifest.version,
                    contributionId, artifactId: graph.artifactId, artifact: graph, generatedOwnerKind: 'clientContribution',
                    artifactSelectionOwner: 'accountRelease', requiredHostMethods: [], exportName: executable.exportName,
                    runtime: Object.freeze({ decision: { state: compatible ? 'load' : 'blocked',
                        reason: compatible ? 'compatible' : 'generated_ui_host_api_mismatch',
                        diagnostics: compatible ? [] : ['generated_ui_host_api_mismatch'] },
                        ...(compatible ? { cacheKey: derivePluginReactNativeBundleCacheKey({ artifactDigest: graph.digest }),
                            cacheIdentity: { artifactDigest: graph.digest }, loadPolicy: { source: 'installedArtifact' } } : {}) }),
                });
                entries[entry.id] = Object.freeze({ ...entry, occurrenceId: custodyId, hostAccountOrigin });
            }
            return compatible;
        };
        const entities = projectAccountClientEntities({ manifest, hostAccountOrigin, projectArtifact: projectAccountArtifact });
        Object.assign(workItems, entities.workItemsById);
        Object.assign(dragSources, entities.dragSourcesById);
        Object.assign(dropTargets, entities.dropTargetsById);
        for (const definition of manifest.contributes.connectedAccountDescriptors ?? []) {
            if (definition.authentication.account) {
                projectAccountArtifact(`connectedAccountDescriptors/${definition.id}`, definition.authentication.account);
            }
            connectedAccountDescriptors[buildQualifiedPluginContributionKey({ pluginId: manifest.id, localId: definition.id })] = Object.freeze({
                id: definition.id, pluginId: manifest.id, occurrenceId: custodyId, definition, hostAccountOrigin,
                nativeLoginRequiredBy: resolveConnectedAccountNativeLoginConstraintsV1({ pluginId: manifest.id, localId: definition.id }, accountAgents),
            });
        }
        const packageAssetsById = new Map(selected.release?.packageAssetArchive?.resources.map(resource => [resource.resourceId, resource]));
        for (const resource of manifest.contributes.resources ?? []) {
            if (resource.source !== 'dynamic') {
                const descriptor = packageAssetsById.get(resource.id);
                resources[buildQualifiedPluginContributionKey({ pluginId: manifest.id, localId: resource.id })] = Object.freeze({
                    id: resource.id, pluginId: manifest.id, occurrenceId: custodyId, resourceKind: resource.kind,
                    path: resource.path, contentType: resource.contentType,
                    ...(descriptor ? { digest: descriptor.digestSha256 } : {}), hostAccountOrigin,
                });
                continue;
            }
            if (resource.execution?.target !== 'account') continue;
            projectAccountArtifact(`resources/${resource.id}`, resource.execution.account);
            resources[buildQualifiedPluginContributionKey({ pluginId: manifest.id, localId: resource.id })] = Object.freeze({
                id: resource.id, pluginId: manifest.id, occurrenceId: custodyId, resourceKind: resource.kind,
                scope: resource.scope, contentType: resource.contentType, execution: resource.execution,
                hostAccountOrigin, accountResourceDeclaration: resource,
            });
        }
        for (const action of manifest.contributes.actions ?? []) {
            if (action.execution.target === 'daemon') continue;
            const execution = action.execution;
            const compatible = projectAccountArtifact(action.id, execution.target === 'account' ? execution.account : execution.client);
            const requestedAccess = action.hostAccess ?? [];
            const optionalAccess = manifest.hostAccess.optional.filter(request => requestedAccess.includes(request.id));
            const requiredAccess = manifest.hostAccess.required.filter(request => requestedAccess.includes(request.id));
            const accountKvAdmission = readCurrentAccountKvCapabilityAdmission(state, input.scope, { pluginId: manifest.id }, candidates);
            const key = buildQualifiedPluginContributionKey({ pluginId: manifest.id, localId: action.id });
            actions[key] = Object.freeze({ id: action.id, pluginId: manifest.id,
                pluginVersion: manifest.version, occurrenceId: custodyId, title: action.title,
                ...(action.description ? { description: action.description } : {}),
                ...(action.icon ? { icon: action.icon } : {}),
                ...projectAccountActionInputHints(action),
                scopes: action.scopes, surfaces: action.surfaces, execution,
                ...(action.sessionTarget ? { sessionTarget: action.sessionTarget } : {}),
                placementBindings: action.placementBindings, dangerLevel: action.dangerLevel,
                ...(action.approvalScope === undefined ? {} : { approvalScope: action.approvalScope }),
                ...(action.confirmation ? { confirmation: action.confirmation } : {}),
                ...(action.confirmationWhen ? { confirmationWhen: action.confirmationWhen } : {}),
                available: compatible, hostAccountOrigin,
                ...(selected.release || state.bundledUiByPluginId.get(manifest.id)?.[0]?.accountExecution
                    ? { accountActionDeclaration: action } : {}),
                authorization: { generation: { targetGeneration: custodyId, desiredGeneration: custodyId, appliedGeneration: null },
                    resourceSelections: optionalAccess.map(request => ({ id: request.id, required: true })), scopedGrants: [],
                    serviceAvailability: [...requiredAccess, ...optionalAccess].map(request => ({ id: request.id, required: true,
                        status: requiredAccess.includes(request) && (request.capability === 'connectedAccounts'
                            || request.capability === 'network'
                            || request.capability === 'storage.account' && accountKvAdmission.kind === 'available')
                            ? 'available' as const : 'unavailable' as const })),
                    operatingSystemAuthorization: [] },
            });
        }
    }
    const withAccountOccurrence = <T extends Readonly<{ pluginId: string }>>(entry: T): T => {
        const hostAccountOrigin = accountUiOrigins.get(entry.pluginId);
        return hostAccountOrigin ? Object.freeze({ ...entry, occurrenceId: hostAccountOrigin.custodyId }) : entry;
    };
    // Normalization requires hosted descriptors to already carry their source
    // occurrence. Account custody owns that identity before remote guards run.
    for (const key of Object.keys(entries)) {
        const entry = entries[key];
        if (entry.contributionKind === 'hostedWeb' || entry.contributionKind === 'reactNativeBundle'
            || entry.contributionKind === 'searchProvider') {
            entries[key] = withAccountOccurrence(entry);
        }
    }
    const projection = normalizePluginInstalledUiDeclarations(entries);
    // An empty current declaration census still withdraws retained Machine
    // renderers. Keep its package rows when an update removes the last view.
    const model = bundles.length > 0 || Object.keys(entries).length > 0 || Object.keys(actions).length > 0 || Object.keys(resources).length > 0
        || Object.keys(connectedAccountDescriptors).length > 0 || Object.keys(workItems).length > 0
        || Object.keys(dragSources).length > 0 || Object.keys(dropTargets).length > 0 ? Object.freeze({ ...projection,
        actionsById: Object.freeze(actions),
        subjectKindsById: Object.freeze(subjectKinds),
        workItemsById: Object.freeze(workItems),
        dragSourcesById: Object.freeze(dragSources),
        dropTargetsById: Object.freeze(dropTargets),
        connectedAccountDescriptorsById: Object.freeze(connectedAccountDescriptors),
        resourcesById: Object.freeze(resources),
        searchProvidersById: Object.freeze(Object.fromEntries(Object.entries(projection.searchProvidersById).flatMap(([key, provider]) => {
            const action = actions[buildQualifiedPluginContributionKey(provider.action)];
            return action ? [[key, Object.freeze({ ...provider, occurrenceId: action.occurrenceId,
                hostAccountOrigin: action.hostAccountOrigin })]] : [];
        }))),
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
            ...projectInstalledActionTitles(readBundledActionTitles(bundle)),
        }])), ...Object.fromEntries(selections.filter(selected => (selected.release && selected.manifest.contributes.ui !== undefined)
            || selected.manifest.contributes.actions?.some(action => action.execution.target !== 'daemon')
            || selected.manifest.contributes.workItems?.length || selected.manifest.contributes.dragSources?.length
            || selected.manifest.contributes.dropTargets?.length
            || (selected.manifest.contributes.connectedAccountDescriptors?.length ?? 0) > 0
            || selected.manifest.contributes.resources?.some(resource => resource.source !== 'dynamic' || resource.execution?.target === 'account'))
            .map(selected => {
                const bundle = bundles.find(candidate => candidate.pluginId === selected.manifest.id);
                return [selected.manifest.id, { id: selected.manifest.id,
                displayName: resolvePluginLocalizedStringV2Text(selected.manifest.displayName),
                version: selected.manifest.version, enabled: true, occurrenceId: selected.custodyId,
                ...((selected.manifest.contributes.resources ?? []).every(resource => resource.source !== 'dynamic'
                    || resource.execution?.target === 'account') ? { resourceDeclarationsComplete: true as const } : {}),
                source: selected.release ? { kind: 'archive', locator: selected.release.archiveDigestSha256 }
                    : { kind: 'bundled', locator: bundle!.packageName },
                ...(selected.release ? { declaredExecution: readManifestDeclaredExecution(selected.manifest) }
                    : bundle?.declaredExecution ? { declaredExecution: bundle.declaredExecution } : {}),
                ...projectInstalledActionTitles(selected.release
                    ? selected.manifest.contributes.actions : readBundledActionTitles(bundle)),
            }]; })) }),
    }) : null;
    const retained = retainAccountUiProjectionRows(previous?.model, model);
    const prepared = retained ? preparePluginUiProjectionOrigins(retained) : null;
    if (pluginId !== undefined && previous) {
        return {
            bundles: [...previous.bundles.filter(bundle => bundle.pluginId !== pluginId), ...bundles],
            selections: [...previous.selections.filter(selected => selected.manifest.id !== pluginId), ...selections],
            model: replaceAccountUiDeclarationSlice(previous.model, prepared, pluginId),
        };
    }
    return { bundles, selections, model: prepared };
}

/**
 * The release-less declaration identity an Event watcher on one Machine reads:
 * that Machine's claim when the plugin has Machine declarations, otherwise the
 * Account-current (legacy) declaration.
 */
function readReleaseLessDeclarationDigest(
    response: PluginAccountAvailabilityIntentReadResponseV1,
    machineId: string | undefined,
    machineInstallationId?: string,
): string | null {
    if (response.machineDeclarations !== undefined) {
        return response.machineDeclarations.find(entry => entry.machineId === machineId
            && (machineInstallationId === undefined || entry.machineInstallationId === machineInstallationId))
            ?.declaration.declarationDigestSha256 ?? null;
    }
    return response.currentDeclaration?.declarationDigestSha256 ?? null;
}

function createBoundReader(input: Readonly<{
    scope: ServerAccountScope;
    readInitialFailure: (pluginId?: string) => ReturnType<ReturnType<typeof createPluginAccountAvailabilityInitialReadiness>['read']>;
    readState: () => AvailabilityProjectionState | null;
    subscribe: PluginAccountAvailabilityReader['subscribe'];
    hostBundledUi?: readonly PreparedBundledUiDeclaration[];
    readDerivedProjection: () => AvailabilityDerivedProjection | null;
    readUiProjectionInputs: () => PluginAccountUiProjectionInputs | null;
    readObservationSnapshot: (pluginId?: string) => object | null;
    loadExactMaterializations?: (pluginId: string, signal: AbortSignal) => Promise<ExactPluginMaterializations | null>;
    ensureBundledDeclarations: (pluginIds: readonly string[]) => Promise<void>;
    ensureTargetDeclarations: (pluginId: string) => Promise<void>;
    /** Content-addressed release-less declaration bodies held for this scope, admitted once. */
    readDeclarationBody: (digest: string) => PluginPortableReleaseManifestV1 | undefined;
    ensureDeclarationBodies: (pluginId: string, digests: readonly string[]) => Promise<void>;
}>): PluginAccountAvailabilityReader {
    const exactMaterializations = new WeakMap<object, Map<string, readonly PluginMachineMaterializationV1[]>>();
    const readCurrentAccountIntent = (pluginId: string): PluginAccountPluginIntentV1 | null | undefined => {
        const state = input.readState();
        if (!state || !readProjectionForScope(state, input.scope) || state.retiredPluginIds?.includes(pluginId)) return undefined;
        const reads = state.intentReadsByPluginId.get(pluginId) ?? [];
        if (reads.length > 1 || (reads.length === 0 && state.intentCensusIncomplete)) return undefined;
        return reads[0]?.response.intent ?? null;
    };
    return Object.freeze({
        getObservationSnapshot: input.readObservationSnapshot,
        readExactMaterializations: async (pluginId, signal) => {
            const observation = input.readObservationSnapshot(pluginId);
            if (!observation || !input.loadExactMaterializations || signal.aborted) return [];
            const held = exactMaterializations.get(observation)?.get(pluginId);
            if (held) return held;
            const result = await input.loadExactMaterializations(pluginId, signal);
            if (!result || signal.aborted || observation !== input.readObservationSnapshot(pluginId)) return [];
            if (result.inventoryComplete) {
                const byPluginId = exactMaterializations.get(observation) ?? new Map();
                byPluginId.set(pluginId, result.rows);
                exactMaterializations.set(observation, byPluginId);
            }
            return result.rows;
        },
        readUiProjectionInputs: input.readUiProjectionInputs,
        readCurrentAccountIntent,
        readCurrentAccountEnablement: (pluginId: string) => {
            const intent = readCurrentAccountIntent(pluginId);
            return intent === undefined ? null : intent?.enabled ?? true;
        },
        readCurrentMachineEnablement: (pluginId, target) => {
            const snapshot = readProjectionForScope(input.readState(), input.scope);
            if (!snapshot || (target === null && snapshot.inventoryComplete === false)) return null;
            const rows = readPluginMachineMaterializations(snapshot.materializations, pluginId);
            const installations = target === null ? rows : rows.filter(row =>
                row.serverIdentityId === target.serverIdentityId && row.machineId === target.machineId);
            return installations.length === 0 ? null : installations.some(row => row.enabled);
        },
        readCurrentAccountExecution: (pluginId: string) => input.readInitialFailure(pluginId)
            ?? readAccountExecutionSelection(input.readState(), input.scope, pluginId),
        readCurrentAutomationEventContribution: (request) => {
            const state = input.readState();
            if (!readProjectionForScope(state, input.scope) || state?.retiredPluginIds?.includes(request.pluginId)) return null;
            const reads = state!.intentReadsByPluginId.get(request.pluginId);
            if (reads?.length !== 1) return null;
            const response = reads[0]!.response;
            if (response.intent?.enabled !== true) return null;
            // Portable release facts already carry the exact selected declaration.
            // Release-less reads require the server's claim, never a local bundle.
            const digest = response.intent.desiredVersion === null
                ? readReleaseLessDeclarationDigest(response, request.machineId, request.machineInstallationId) : null;
            const manifest = response.intent.desiredVersion === null
                ? digest ? input.readDeclarationBody(digest) ?? null : null
                : response.release && response.intent.desiredVersion === response.release.ref.version ? response.release.normalizedManifest : null;
            if (manifest?.id !== request.pluginId || manifest.version !== request.version || !manifest.contributes.events) return null;
            return readAutomationEligibleEventContributionV1({ events: manifest.contributes.events,
                eventLocalId: request.eventLocalId, sourceContractVersion: request.sourceContractVersion });
        },
        ensureAutomationEventDeclarations: async ({ pluginId, machineId }) => {
            const state = input.readState();
            if (!readProjectionForScope(state, input.scope) || state?.retiredPluginIds?.includes(pluginId)) return;
            const reads = state!.intentReadsByPluginId.get(pluginId);
            if (reads?.length !== 1) return;
            const response = reads[0]!.response;
            if (response.intent?.enabled !== true || response.intent.desiredVersion !== null) return;
            const digest = readReleaseLessDeclarationDigest(response, machineId);
            if (digest && !input.readDeclarationBody(digest)) await input.ensureDeclarationBodies(pluginId, [digest]);
        },
        ensureCurrentAccountExecution: async (pluginId: string) => {
            const current = input.readInitialFailure(pluginId) ?? readAccountExecutionSelection(input.readState(), input.scope, pluginId);
            if (current.kind === 'unavailable' && current.code === 'plugin_ui_declaration_pending') await input.ensureBundledDeclarations([pluginId]);
            return input.readInitialFailure(pluginId) ?? readAccountExecutionSelection(input.readState(), input.scope, pluginId);
        },
        ensureAccountTargetDeclarations: async (pluginId: string) => {
            if (readProjectionForScope(input.readState(), input.scope)) await input.ensureTargetDeclarations(pluginId);
        },
        readCurrentAccountExecutionDeclarations: () => readAccountExecutionSelections(input.readState(), input.scope, input.hostBundledUi ?? []),
        ensureCurrentAccountExecutionDeclarations: async ({ family }) => {
            const state = input.readState();
            if (!readProjectionForScope(state, input.scope)) return input.readInitialFailure() ?? { kind: 'unavailable',
                code: state ? 'account_availability_scope_mismatch' : 'account_availability_not_loaded' };
            const candidates = readAccountExecutionSelections(input.readState(), input.scope, input.hostBundledUi ?? [], true)
                .filter(selection => (selection.manifest.contributes[family]?.length ?? 0) > 0
                    // First paint empties contribution families; the bundle's demand index names the ones it has.
                    || selection.release === null && input.hostBundledUi?.some(bundle => bundle.pluginId === selection.manifest.id
                        && (family === 'machineProvisioners' ? bundle.hasMachineProvisioners
                            : family === 'deploymentTargets' ? bundle.hasDeploymentTargets : bundle.hasMachineRecipes) === true));
            await input.ensureBundledDeclarations(candidates.map(selection => selection.manifest.id));
            if (!readProjectionForScope(input.readState(), input.scope)) return { kind: 'unavailable', code: 'account_availability_scope_mismatch' };
            return { kind: 'available', declarations: readAccountExecutionSelections(input.readState(), input.scope, input.hostBundledUi ?? [])
                .filter(selection => (selection.manifest.contributes[family]?.length ?? 0) > 0) };
        },
        readAccountUiProjection: () => input.readDerivedProjection()?.accountUi.model ?? null,
        readCurrentArtifact: (slot, executionOrigin, daemonProjectionSelection) => input.readInitialFailure(slot.pluginId) ?? readCurrentArtifactAdmission(
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
 * A cold invocation joins the Availability publisher for its plugin. Lazy
 * declarations still load through the same owner as mounted readers.
 */
export async function settlePluginAccountExecution(
    reader: PluginAccountAvailabilityReader,
    pluginId: string,
    signal: AbortSignal,
): Promise<PluginAccountExecutionAdmission | null> {
    if (signal.aborted) return null;
    const read = () => reader.readCurrentAccountExecution(pluginId);
    const isAwaitingCensus = (admission: PluginAccountExecutionAdmission) =>
        admission.kind === 'unavailable' && admission.code === 'account_availability_not_loaded';
    let admission = read();
    if (isAwaitingCensus(admission)) {
        const published = await new Promise<PluginAccountExecutionAdmission | null>(resolve => {
            const finish = (result: PluginAccountExecutionAdmission | null) => {
                unsubscribe();
                signal.removeEventListener('abort', abort);
                resolve(result);
            };
            const abort = () => finish(null);
            const observe = () => {
                const current = read();
                if (!isAwaitingCensus(current)) finish(current);
            };
            const unsubscribe = reader.subscribe(observe, pluginId);
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
            else observe();
        });
        if (!published || signal.aborted) return null;
        admission = published;
    }
    return admission.kind === 'unavailable' && admission.code === 'plugin_ui_declaration_pending'
        ? reader.ensureCurrentAccountExecution(pluginId) : admission;
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
export function createPluginAccountAvailabilityReaderStore(input: (Readonly<{
    hostBundledUi?: readonly PluginHostBundledUiDeclaration[];
    loadHostBundledUi?: never;
}> | Readonly<{
    hostBundledUi?: never;
    /** App-owned package facts are acquired before the first Account publication, not anonymous boot. */
    loadHostBundledUi: () => readonly PluginHostBundledUiDeclaration[];
}>) & Readonly<{
    /** Reads release-less declaration bodies by digest (admitted at that read) for a demanded plugin. */
    loadDeclarationBodies?: (scope: ServerAccountScope, pluginId: string, digests: readonly string[])
        => Promise<readonly PluginAccountDeclarationBodyV1[]>;
    loadExactMaterializations?: (scope: ServerAccountScope, pluginId: string, signal: AbortSignal)
        => Promise<ExactPluginMaterializations | null>;
}> = {}): PluginAccountAvailabilityReaderStore {
    let loadHostBundledUi = input.loadHostBundledUi;
    let hostBundledUi = loadHostBundledUi ? Object.freeze([]) : prepareBundledUiDeclarations(input.hostBundledUi ?? []);
    let bundledUiByPluginId = indexAvailabilityRows(hostBundledUi, bundle => bundle.pluginId);
    let state: AvailabilityProjectionState | null = null;
    // Content-addressed declaration bodies for the current scope: shared by every
    // Machine and intent read that names a digest, admitted once, kept across
    // publications of the same scope and dropped with it.
    let declarationBodies: Readonly<{ scope: ServerAccountScope; byDigest: Map<string, PluginPortableReleaseManifestV1> }> | null = null;
    const declarationBodyLoads = new Map<string, Promise<void>>();
    const initialReadiness = createPluginAccountAvailabilityInitialReadiness();
    let derived: AvailabilityDerivedProjection | null = null;
    let observations: AvailabilityObservations | undefined;
    let boundReader: Readonly<{ scope: ServerAccountScope; reader: PluginAccountAvailabilityReader }> | undefined;
    const getObservationSnapshot = (pluginId?: string): object | null => {
        const failure = initialReadiness.getSnapshot();
        if (failure) return failure;
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
        if (declarationBodies && !areServerAccountScopesEqual(declarationBodies.scope, next.scope)) declarationBodies = null;
        if (sameScope && state!.snapshot.availabilityCursor === next.snapshot.availabilityCursor
            && state!.intentCensusIncomplete === next.intentCensusIncomplete
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
            releasesByPluginId: sameScope && state!.snapshot.releases === next.snapshot.releases
                ? state!.releasesByPluginId : indexAvailabilityRows(next.snapshot.releases ?? [], row => row.ref.pluginId),
        });
        const admitted = retainIfEqual(sameScope ? derived?.materializations : undefined,
            readMaterializationAdmission(nextState, nextState.scope));
        const nextProjection = {
            materializations: admitted,
            installed: readInstalledPluginsAdmission(nextState, nextState.scope, admitted,
                sameScope && derived ? { state: state!, installed: derived.installed } : undefined),
            accountUi: deriveAccountUiProjection({ scope: nextState.scope, hostBundledUi }, nextState,
                sameScope ? derived?.accountUi : undefined),
        };
        const previousInputs = sameScope ? derived?.uiInputs : undefined;
        const materializations = retainUiMaterializations(previousInputs?.materializations,
            nextProjection.materializations.kind === 'available' ? nextProjection.materializations.materializations : []);
        const installedPlugins = retainUiInstalledPlugins(previousInputs?.installedPlugins,
            nextProjection.installed.kind === 'available' ? nextProjection.installed.plugins : undefined,
            sameScope && derived?.installed.kind === 'available' ? derived.installed.plugins : undefined);
        const accountUiProjection = nextProjection.accountUi.model;
        const nextObservations = deriveAvailabilityObservations(nextState, nextProjection.accountUi.selections, nextProjection.installed,
            sameScope ? observations : undefined,
            state?.snapshot.availabilityCursor);
        const reportedMachines = nextObservations.empty.value.machines;
        const uiInputs = previousInputs && previousInputs.materializations === materializations
            && previousInputs.installedPlugins === installedPlugins && previousInputs.accountUiProjection === accountUiProjection
            && previousInputs.reportedMachines === reportedMachines
            && state!.snapshot.inventoryComplete === nextState.snapshot.inventoryComplete
            && sameStrictJsonValue(state!.retiredPluginIds ?? [], nextState.retiredPluginIds ?? [])
            ? previousInputs : Object.freeze({ materializations, installedPlugins, reportedMachines, accountUiProjection });
        const nextDerived = Object.freeze({ ...nextProjection, uiInputs });
        state = nextState;
        const initialFailure = initialReadiness.getSnapshot();
        if (initialFailure && nextState.intentCensusIncomplete && areServerAccountScopesEqual(initialFailure.scope, nextState.scope)) {
            initialReadiness.fail(initialFailure, uiInputs);
        } else initialReadiness.clear();
        derived = nextDerived;
        observations = nextObservations;
        return true;
    };
    const publishDeclaration = (pluginId: string) => {
        if (!state || !derived || !observations) return false;
        const nextState = Object.freeze({ ...state, bundledUiByPluginId });
        let installed = derived.installed;
        let installedPlugins = derived.uiInputs.installedPlugins;
        if (installed.kind === 'available') {
            const prior = installed.plugins.find(plugin => plugin.pluginId === pluginId);
            if (prior) {
                const updated = readInstalledPluginRows(nextState, nextState.scope,
                    prior.installations.map(installation => installation.materialization), [prior])[0]!;
                if (updated !== prior) {
                    installed = Object.freeze({ ...installed,
                        plugins: Object.freeze(installed.plugins.map(plugin => plugin === prior ? updated : plugin)) });
                    // UI rows can predate a clock-only census update. Match only this
                    // group's canonical identities, preserving its existing UI order.
                    const installations = new Map(updated.installations.map(installation =>
                        [materializationLookupKey(installation.materialization), installation] as const));
                    installedPlugins = installedPlugins && Object.freeze(installedPlugins.map(plugin => plugin.pluginId === pluginId
                        ? Object.freeze({ ...plugin, installations: Object.freeze(plugin.installations.map(installation =>
                            installations.get(materializationLookupKey(installation.materialization))!)) }) : plugin));
                }
            }
        }
        const accountUi = deriveAccountUiProjection({ scope: nextState.scope, hostBundledUi }, nextState, derived.accountUi, pluginId);
        const uiInputs = installedPlugins === derived.uiInputs.installedPlugins && accountUi.model === derived.uiInputs.accountUiProjection
            ? derived.uiInputs : Object.freeze({ ...derived.uiInputs, installedPlugins, accountUiProjection: accountUi.model });
        const nextObservations = deriveDeclarationAvailabilityObservations(nextState, pluginId,
            derived.accountUi.selections, accountUi.selections, observations);
        const changed = uiInputs !== derived.uiInputs || nextObservations !== observations;
        state = nextState;
        derived = Object.freeze({ ...derived, installed, accountUi, uiInputs });
        observations = nextObservations;
        const initialFailure = initialReadiness.getSnapshot();
        if (initialFailure && nextState.intentCensusIncomplete && areServerAccountScopesEqual(initialFailure.scope, nextState.scope)) {
            initialReadiness.fail(initialFailure, uiInputs);
        }
        return changed;
    };
    const listeners = new Set<() => void>();
    const pluginListeners = new Set<{
        listener: () => void;
        readSnapshot: () => object | null;
        snapshot: object | null;
    }>();
    const notify = () => {
        // Publication owns the lifecycle signal. Cursor-only Account updates do
        // not invalidate a plugin whose observed authority is unchanged.
        for (const subscription of pluginListeners) {
            const snapshot = subscription.readSnapshot();
            if (snapshot === subscription.snapshot) continue;
            subscription.snapshot = snapshot;
            subscription.listener();
        }
        for (const listener of listeners) listener();
    };
    const subscribe = (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
    };
    const declarationLoads = new Map<string, Promise<PreparedBundledUiDeclaration | undefined>>();
    const loadBundledDeclaration = (pluginId: string): Promise<PreparedBundledUiDeclaration | undefined> => {
        const candidates = bundledUiByPluginId.get(pluginId);
        const bundle = candidates?.length === 1 ? candidates[0] : undefined;
        if (!bundle?.loadDeclaration || bundle.normalizedManifest) return Promise.resolve(undefined);
        const pending = declarationLoads.get(pluginId);
        if (pending) return pending;
        const operation = Promise.resolve().then(() => bundle.loadDeclaration!()).then(declaration => {
            if (declaration.pluginId !== bundle.pluginId || declaration.pluginVersion !== bundle.pluginVersion
                || declaration.packageName !== bundle.packageName || declaration.normalizedManifest?.id !== bundle.pluginId
                || declaration.normalizedManifest.version !== bundle.pluginVersion) {
                throw Object.assign(new Error('Bundled Plugin UI declaration identity mismatch'), { code: 'plugin_ui_declaration_invalid' });
            }
            return prepareBundledUiDeclarations([declaration])[0]!;
        }).catch(error => {
            declarationLoads.delete(pluginId);
            logPluginSurfaceDiagnostic({ pluginId, contributionId: null, surfaceId: null }, {
                kind: 'bundled_declaration_unavailable',
                failureDiagnostic: readActionOutputDiagnostic(withActionFailureCauseDiagnostic({}, error, 'plugin_ui.bundled_declaration')),
            });
            throw error;
        });
        declarationLoads.set(pluginId, operation);
        return operation;
    };
    const ensureBundledDeclarations = async (pluginIds: readonly string[]): Promise<void> => {
        // A catalog demand consumes the whole set. Keep acquisition shared, but
        // publish once when that set settles instead of re-rendering on every asset arrival.
        const declarations = await Promise.allSettled(pluginIds.map(loadBundledDeclaration));
        let changed = false;
        for (const result of declarations) {
            if (result.status !== 'fulfilled' || !result.value) continue;
            const prepared = result.value;
            declarationLoads.delete(prepared.pluginId);
            const bundle = bundledUiByPluginId.get(prepared.pluginId)?.[0];
            // An overlapping individual or catalog demand may already have published this load.
            if (bundle?.normalizedManifest) continue;
            hostBundledUi = Object.freeze(hostBundledUi.map(current => current === bundle ? prepared : current));
            bundledUiByPluginId = new Map(bundledUiByPluginId).set(prepared.pluginId, Object.freeze([prepared]));
            changed = publishDeclaration(prepared.pluginId) || changed;
        }
        if (changed) notify();
        const failure = declarations.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
    };
    const readDeclarationBody = (scope: ServerAccountScope, digest: string) => declarationBodies
        && areServerAccountScopesEqual(declarationBodies.scope, scope) ? declarationBodies.byDigest.get(digest) : undefined;
    /** Reads only digests this scope does not hold; one in-flight read per digest. */
    const ensureDeclarationBodies = async (scope: ServerAccountScope, pluginId: string, digests: readonly string[]) => {
        const load = input.loadDeclarationBodies;
        if (!load) return;
        const key = (digest: string) => `${scope.serverId}\0${scope.accountId}\0${digest}`;
        const missing = [...new Set(digests)].filter(digest => !readDeclarationBody(scope, digest));
        const pending = missing.flatMap(digest => declarationBodyLoads.get(key(digest)) ?? []);
        const started = missing.filter(digest => !declarationBodyLoads.has(key(digest)));
        if (started.length > 0) {
            const operation = load(scope, pluginId, started).then(bodies => {
                if (!state || !areServerAccountScopesEqual(state.scope, scope)) return;
                if (!declarationBodies || !areServerAccountScopesEqual(declarationBodies.scope, scope)) {
                    declarationBodies = Object.freeze({ scope, byDigest: new Map() });
                }
                let added = false;
                for (const body of bodies) {
                    if (declarationBodies.byDigest.has(body.declarationDigestSha256)) continue;
                    declarationBodies.byDigest.set(body.declarationDigestSha256, freezeDeepDeclaration(body.manifest));
                    added = true;
                }
                if (!added || !observations) return;
                // Body arrival changes what this plugin's readers can resolve.
                const prior = observations.byPluginId.get(pluginId);
                observations = Object.freeze({ ...observations, all: Object.freeze({}),
                    byPluginId: prior ? new Map(observations.byPluginId).set(pluginId, Object.freeze({ ...prior, token: Object.freeze({}) }))
                        : observations.byPluginId });
                notify();
            }).finally(() => { for (const digest of started) declarationBodyLoads.delete(key(digest)); });
            for (const digest of started) declarationBodyLoads.set(key(digest), operation);
            pending.push(operation);
        }
        await Promise.all(pending);
    };
    const ensureTargetDeclarations = async (pluginId: string) => {
        await ensureBundledDeclarations(hostBundledUi.filter(bundle => {
            if (bundle.pluginId !== pluginId && !bundle.targetedPluginIds?.includes(pluginId)) return false;
            const current = state && readAccountExecutionSelection(state, state.scope, bundle.pluginId);
            return current?.kind === 'unavailable' && current.code === 'plugin_ui_declaration_pending';
        }).map(bundle => bundle.pluginId));
    };
    return Object.freeze({
        fail: (failure) => {
            if (state && areServerAccountScopesEqual(state.scope, failure.scope) && !state.intentCensusIncomplete) return;
            if (initialReadiness.fail(failure, state && areServerAccountScopesEqual(state.scope, failure.scope)
                ? derived?.uiInputs : undefined)) notify();
        },
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
            const inventory = input.pluginIds
                ? mergeNamedPluginInventory(canMerge ? previous.snapshot : null, incoming, new Set(input.pluginIds))
                : Object.freeze({
                    snapshots: [...retainedSnapshots, ...incoming.snapshots],
                    materializations: [...retainedMaterializations, ...incoming.materializations],
                    releases: [...retainedReleases, ...(incoming.releases ?? [])],
                });
            const replacedPluginIds = new Set(incoming.intentReads.map((entry) => entry.pluginId));
            const retainedIntentReads = canMerge
                ? previous.snapshot.intentReads.filter((entry) => !replacedPluginIds.has(entry.pluginId))
                : [];
            const previousIntentReads = new Map(canMerge ? previous.snapshot.intentReads.map(entry => [entry.pluginId, entry]) : []);
            const intentReads = retainAvailabilityRows(canMerge ? previous.snapshot.intentReads : undefined,
                Object.freeze([...retainedIntentReads, ...incoming.intentReads]
                .map(entry => {
                    const held = previousIntentReads.get(entry.pluginId);
                    if (held === entry) return held;
                    const release = retainIfEqual(held?.response.release, entry.response.release);
                    return release === entry.response.release ? entry : Object.freeze({ ...entry,
                        response: Object.freeze({ ...entry.response, release }) });
                })
                .sort((left, right) => compareCodeUnits(left.pluginId, right.pluginId))));
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
                intentCensusIncomplete: input.intentCensusIncomplete === true && (!canMerge || previous.intentCensusIncomplete === true),
                retiredPluginIds: canMerge ? previous.retiredPluginIds?.filter(pluginId => !replacedPluginIds.has(pluginId)) : [],
                stalePluginIds: Object.freeze([...stalePluginIds].sort(compareCodeUnits)),
                snapshot: Object.freeze({
                    ...incoming,
                    availabilityCursor: Math.max(
                        incoming.availabilityCursor,
                        ...incoming.intentReads.map((entry) => entry.response.availabilityCursor),
                        ...(canMerge ? retainedIntentReads.map((entry) => entry.response.availabilityCursor) : []),
                    ),
                    intentReads,
                    snapshots: retainAvailabilityRows(canMerge ? previous.snapshot.snapshots : undefined,
                        Object.freeze(inventory.snapshots)),
                    materializations: retainAvailabilityRows(canMerge ? previous.snapshot.materializations : undefined,
                        Object.freeze(inventory.materializations)),
                    releases: retainAvailabilityRows(canMerge ? previous.snapshot.releases : undefined,
                        Object.freeze(inventory.releases)),
                }),
            }));
            const failed = input.initialFailure && state?.intentCensusIncomplete
                && areServerAccountScopesEqual(input.initialFailure.scope, input.scope)
                ? initialReadiness.fail(input.initialFailure, derived?.uiInputs) : false;
            if (changed || failed) notify();
            return previous;
        },
        clear: () => {
            const previous = state;
            const failed = initialReadiness.clear();
            declarationBodies = null;
            if (!previous && !failed) return previous;
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
                intentCensusIncomplete: state.intentCensusIncomplete,
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
            const readObservationSnapshot = (pluginId?: string) => initialReadiness.read(scoped) ? initialReadiness.getSnapshot()
                : state && areServerAccountScopesEqual(state.scope, scoped) ? getObservationSnapshot(pluginId) : null;
            const reader = createBoundReader({
                scope: scoped,
                readInitialFailure: (pluginId) => pluginId !== undefined && state && areServerAccountScopesEqual(state.scope, scoped)
                    && (state.intentReadsByPluginId.has(pluginId) || state.retiredPluginIds?.includes(pluginId))
                    ? null : initialReadiness.read(scoped),
                readState: () => state,
                subscribe: (listener, pluginId) => {
                    if (pluginId === undefined) return subscribe(listener);
                    const readSnapshot = () => readObservationSnapshot(pluginId);
                    const subscription = { listener, readSnapshot, snapshot: readSnapshot() };
                    pluginListeners.add(subscription);
                    return () => { pluginListeners.delete(subscription); };
                },
                get hostBundledUi() { return hostBundledUi; },
                readDerivedProjection: () => state && areServerAccountScopesEqual(state.scope, scoped) ? derived : null,
                readUiProjectionInputs: () => initialReadiness.readUiProjectionInputs(scoped)
                    ?? (state && areServerAccountScopesEqual(state.scope, scoped) ? derived?.uiInputs ?? null : null),
                readObservationSnapshot,
                loadExactMaterializations: input.loadExactMaterializations?.bind(undefined, scoped),
                ensureBundledDeclarations,
                ensureTargetDeclarations,
                readDeclarationBody: (digest) => readDeclarationBody(scoped, digest),
                ensureDeclarationBodies: (pluginId, digests) => ensureDeclarationBodies(scoped, pluginId, digests),
            });
            if (!state || areServerAccountScopesEqual(state.scope, scoped)) boundReader = { scope: scoped, reader };
            return reader;
        },
    });
}
