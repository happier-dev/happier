import {
    normalizePluginAccountCollectionContractsV1,
    type NormalizedPluginAccountCollectionContractV1,
    type PluginCollectionCandidatePreparationBindingV1,
    type PluginCollectionContractRefV1,
} from '@happier-dev/protocol';
import type {
    PluginAvailabilityIntentSetActionInputV1,
    PluginAvailabilityIntentSetActionOutputV1,
} from '@happier-dev/protocol/plugins/availability';

import {
    createActivePluginCollectionCandidatePreparation,
} from '@/sync/api/plugins/data/candidatePluginCollectionPreparation';
import {
    setActivePluginAccountAvailabilityIntent,
    type ActivePluginAccountAvailabilityIntentSetResult,
} from '@/sync/api/plugins/availability/setActivePluginAccountAvailabilityIntent';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

import {
    getCandidatePluginCollectionMigrationArtifactLoader,
    type CandidatePluginCollectionMigrationArtifactLoadInput,
    type CandidatePluginCollectionMigrationArtifactTarget,
} from './candidateCollectionMigrationArtifact';
import type { PluginAccountAvailabilityReader } from './reader';

type CandidateCollectionReleaseSourceSelection = Extract<
    ReturnType<PluginAccountAvailabilityReader['readCurrentReleaseSelection']>,
    { kind: 'available' }
>;

export type CandidateCollectionReleaseSelectionPreparedStage = Readonly<{
    /** Retires exactly the stage that this preparation created. */
    retire: () => Promise<void>;
}>;

export type CandidateCollectionReleaseSelectionPreparationUnavailableCode =
    | 'source_release_changed'
    | 'target_contract_mismatch'
    | 'candidate_preparation_unavailable';

export type CandidateCollectionReleaseSelectionPreparationResult =
    | Readonly<{
        kind: 'prepared';
        stage: CandidateCollectionReleaseSelectionPreparedStage;
    }>
    | Readonly<{
        kind: 'unavailable';
        code: CandidateCollectionReleaseSelectionPreparationUnavailableCode;
    }>;

export type CandidateCollectionReleaseSelectionPreparationInput = Readonly<{
    source: Readonly<{
        release: CandidateCollectionReleaseSourceSelection['release']['ref'];
        collectionContracts: readonly NormalizedPluginAccountCollectionContractV1[];
    }>;
    target: Readonly<{
        release: CandidatePluginCollectionMigrationArtifactTarget['release'];
        collectionContracts: readonly PluginCollectionContractRefV1[];
    }>;
    accountLifetime: ActiveServerAccountScopeLifetime;
    /** Includes present-user action, Account lifetime, and source-release currentness. */
    isCurrent: () => boolean;
}>;

type CandidateCollectionReleaseSelectionDirectUiPreparation = Readonly<{
    kind: 'direct-ui';
    /** Exact executable target facts, intentionally absent from CAS-only selection. */
    candidateTarget: Omit<CandidatePluginCollectionMigrationArtifactTarget, 'release'>;
    artifact: Omit<CandidatePluginCollectionMigrationArtifactLoadInput, 'accountLifetime' | 'isCurrent' | 'target'>;
}>;

type CandidateCollectionReleaseSelectionDirectUiTargetPreparation = Readonly<{
    kind: 'direct-ui-target';
    /**
     * Resolves prospective Account-hosted target facts only after the exact
     * Availability refusal authorizes candidate preparation.
     */
    resolve: (input: Readonly<{
        accountLifetime: ActiveServerAccountScopeLifetime;
        isCurrent: () => boolean;
    }>) => Promise<
        | Readonly<{
            kind: 'available';
            candidateTarget: CandidatePluginCollectionMigrationArtifactTarget;
            artifact: Omit<CandidatePluginCollectionMigrationArtifactLoadInput, 'accountLifetime' | 'isCurrent' | 'target'>;
        }>
        | Readonly<{ kind: 'unavailable' }>
    >;
}>;

type CandidateCollectionReleaseSelectionDaemonPreparation = Readonly<{
    kind: 'daemon';
    /**
     * Host-private bridge supplied only after the caller selected an exact
     * trusted daemon. It owns daemon execution, not Availability CAS/retry.
     */
    prepare: (input: CandidateCollectionReleaseSelectionPreparationInput) => Promise<CandidateCollectionReleaseSelectionPreparationResult>;
}>;

export type CandidateCollectionReleaseSelectionPreparation =
    | CandidateCollectionReleaseSelectionDirectUiPreparation
    | CandidateCollectionReleaseSelectionDirectUiTargetPreparation
    | CandidateCollectionReleaseSelectionDaemonPreparation;

export type CandidateCollectionReleaseSelectionTarget = Readonly<{
    /** Static target release facts used by the initial Availability CAS. */
    release: CandidatePluginCollectionMigrationArtifactTarget['release'];
    collectionContracts: readonly PluginCollectionContractRefV1[];
    /** The exact Availability CAS facts for this present-user release selection. */
    intent: Readonly<Pick<
        PluginAvailabilityIntentSetActionInputV1,
        'enabled' | 'offlineUiHosting' | 'expectedRevision'
    >>;
    /** Acquired only if the canonical Availability owner requires preparation. */
    preparation?: CandidateCollectionReleaseSelectionPreparation;
}>;

export type CandidateCollectionReleaseSelectionResult =
    | Readonly<{ kind: 'selected'; intent: PluginAvailabilityIntentSetActionOutputV1['intent'] }>
    | Readonly<{ kind: 'cancelled' }>
    | Readonly<{ kind: 'conflict'; code: 'intent_revision_conflict' }>
    | Readonly<{
        kind: 'unavailable';
        code:
            | 'source_release_unavailable'
            | CandidateCollectionReleaseSelectionPreparationUnavailableCode
            | 'intent_set_unavailable';
    }>
    | Readonly<{ kind: 'rejected'; code: 'intent_set_rejected' }>;

type CandidatePreparation = ReturnType<typeof createActivePluginCollectionCandidatePreparation>;

export type CandidateCollectionReleaseSelectionDependencies = Readonly<{
    artifactLoader: ReturnType<typeof getCandidatePluginCollectionMigrationArtifactLoader>;
    createPreparation: typeof createActivePluginCollectionCandidatePreparation;
    setIntent: (input: Parameters<typeof setActivePluginAccountAvailabilityIntent>[0]) => Promise<ActivePluginAccountAvailabilityIntentSetResult>;
}>;

function defaultDependencies(): CandidateCollectionReleaseSelectionDependencies {
    return {
        artifactLoader: getCandidatePluginCollectionMigrationArtifactLoader(),
        createPreparation: createActivePluginCollectionCandidatePreparation,
        setIntent: setActivePluginAccountAvailabilityIntent,
    };
}

function sameRef(left: PluginCollectionContractRefV1, right: PluginCollectionContractRefV1): boolean {
    return left.pluginId === right.pluginId
        && left.collectionId === right.collectionId
        && left.schemaVersion === right.schemaVersion
        && left.contractDigest === right.contractDigest;
}

function sameRefSet(
    left: readonly PluginCollectionContractRefV1[],
    right: readonly PluginCollectionContractRefV1[],
): boolean {
    return left.length === right.length
        && left.every((candidate) => right.some((other) => sameRef(candidate, other)));
}

function createTargetIntentSetInput(
    target: CandidateCollectionReleaseSelectionTarget,
): PluginAvailabilityIntentSetActionInputV1 {
    return {
        pluginId: target.release.pluginId,
        desiredVersion: target.release.version,
        enabled: target.intent.enabled,
        offlineUiHosting: target.intent.offlineUiHosting,
        writableCollections: target.collectionContracts.map((contract) => ({ ...contract })),
        expectedRevision: target.intent.expectedRevision,
    };
}

function selectionResultForSettledIntent(
    set: ActivePluginAccountAvailabilityIntentSetResult,
): CandidateCollectionReleaseSelectionResult | null {
    switch (set.kind) {
        case 'updated':
            return Object.freeze({ kind: 'selected', intent: set.intent });
        case 'conflict':
            return Object.freeze({ kind: 'conflict', code: 'intent_revision_conflict' });
        case 'unavailable':
            return Object.freeze({ kind: 'unavailable', code: 'intent_set_unavailable' });
        case 'rejected':
            return Object.freeze({ kind: 'rejected', code: 'intent_set_rejected' });
        case 'preparationRequired':
            return null;
    }
}

function sameSourceSelection(
    reader: PluginAccountAvailabilityReader,
    source: CandidateCollectionReleaseSourceSelection,
): boolean {
    const current = reader.readCurrentReleaseSelection({ pluginId: source.intent.pluginId });
    return current.kind === 'available'
        && current.availabilityCursor === source.availabilityCursor
        && current.intent.revision === source.intent.revision
        && current.release.ref.pluginId === source.release.ref.pluginId
        && current.release.ref.version === source.release.ref.version;
}

function actionIsCurrent(input: Readonly<{
    isCurrent?: () => boolean;
}>): boolean {
    try {
        return input.isCurrent?.() ?? true;
    } catch {
        return false;
    }
}

async function retirePreparations(preparations: readonly CandidatePreparation[]): Promise<void> {
    await Promise.all(preparations.map(async (preparation) => {
        try {
            await preparation.retire();
        } catch {
            // The Data owner retains the exact staged-binding cleanup on retry.
        }
    }));
}

async function retirePreparedStage(stage: CandidateCollectionReleaseSelectionPreparedStage): Promise<void> {
    try {
        await stage.retire();
    } catch {
        // The preparation host retains exact staged-binding cleanup on retry.
    }
}

function preparedStage(
    preparations: readonly CandidatePreparation[],
): CandidateCollectionReleaseSelectionPreparedStage {
    return Object.freeze({
        retire: async () => await retirePreparations(preparations),
    });
}

async function prepareDirectUiCandidate(input: Readonly<{
    dependencies: CandidateCollectionReleaseSelectionDependencies;
    accountLifetime: ActiveServerAccountScopeLifetime;
    source: CandidateCollectionReleaseSourceSelection;
    sourceContracts: readonly NormalizedPluginAccountCollectionContractV1[];
    sourceIsCurrent: () => boolean;
    target: CandidateCollectionReleaseSelectionTarget;
    preparation: CandidateCollectionReleaseSelectionDirectUiPreparation;
}>): Promise<CandidateCollectionReleaseSelectionPreparationResult> {
    const candidateTarget: CandidatePluginCollectionMigrationArtifactTarget = Object.freeze({
        release: input.target.release,
        ...input.preparation.candidateTarget,
    });
    const loaded = await input.dependencies.artifactLoader.load({
        ...input.preparation.artifact,
        accountLifetime: input.accountLifetime,
        isCurrent: input.sourceIsCurrent,
        target: candidateTarget,
    });
    if (loaded.kind !== 'available') {
        return Object.freeze({
            kind: 'unavailable',
            code: loaded.code === 'candidate_currentness_changed'
                ? 'source_release_changed'
                : 'candidate_preparation_unavailable',
        });
    }
    const candidate = loaded.candidate;
    const preparations: CandidatePreparation[] = [];
    try {
        const targetRefs = candidate.collectionContracts.map((contract) => ({
            pluginId: contract.pluginId,
            collectionId: contract.collectionId,
            schemaVersion: contract.schemaVersion,
            contractDigest: contract.contractDigest,
        }));
        if (
            !sameRefSet(targetRefs, input.target.collectionContracts)
            || candidate.release.ref.pluginId !== input.target.release.pluginId
            || candidate.release.ref.version !== input.target.release.version
        ) {
            return Object.freeze({ kind: 'unavailable', code: 'target_contract_mismatch' });
        }
        for (const sourceContract of input.sourceContracts) {
            if (!input.sourceIsCurrent() || !candidate.isCurrent()) {
                await retirePreparations(preparations);
                return Object.freeze({ kind: 'unavailable', code: 'source_release_changed' });
            }
            const targetContract = candidate.collectionContracts.find((contract) => (
                contract.collectionId === sourceContract.collectionId
            ));
            if (!targetContract) {
                await retirePreparations(preparations);
                return Object.freeze({ kind: 'unavailable', code: 'target_contract_mismatch' });
            }
            const binding: PluginCollectionCandidatePreparationBindingV1 = Object.freeze({
                source: Object.freeze({
                    pluginId: sourceContract.pluginId,
                    collectionId: sourceContract.collectionId,
                    schemaVersion: sourceContract.schemaVersion,
                    contractDigest: sourceContract.contractDigest,
                }),
                target: Object.freeze({
                    pluginId: targetContract.pluginId,
                    collectionId: targetContract.collectionId,
                    schemaVersion: targetContract.schemaVersion,
                    contractDigest: targetContract.contractDigest,
                }),
                candidate: Object.freeze({
                    releaseVersion: candidate.release.ref.version,
                    // The loader has already verified the executable graph and cache identity.
                    artifactDigest: candidateTarget.artifact.digest,
                }),
            });
            const preparation = input.dependencies.createPreparation({
                candidate: Object.freeze({
                    accountLifetime: input.accountLifetime,
                    binding,
                    sourceContract,
                    targetContract,
                    collectionMigrations: candidate.collectionMigrations,
                    isCurrent: input.sourceIsCurrent,
                }),
            });
            preparations.push(preparation);
            const prepared = await preparation.prepare();
            if (prepared.kind !== 'prepared') {
                await retirePreparations(preparations);
                return Object.freeze({ kind: 'unavailable', code: 'candidate_preparation_unavailable' });
            }
        }
        if (!input.sourceIsCurrent() || !candidate.isCurrent()) {
            await retirePreparations(preparations);
            return Object.freeze({ kind: 'unavailable', code: 'source_release_changed' });
        }
        return Object.freeze({ kind: 'prepared', stage: preparedStage(preparations) });
    } finally {
        candidate.dispose();
    }
}

async function prepareCandidateCollectionRelease(input: Readonly<{
    dependencies: CandidateCollectionReleaseSelectionDependencies;
    accountLifetime: ActiveServerAccountScopeLifetime;
    source: CandidateCollectionReleaseSourceSelection;
    sourceContracts: readonly NormalizedPluginAccountCollectionContractV1[];
    sourceIsCurrent: () => boolean;
    target: CandidateCollectionReleaseSelectionTarget;
    preparation: CandidateCollectionReleaseSelectionPreparation;
}>): Promise<CandidateCollectionReleaseSelectionPreparationResult> {
    if (input.preparation.kind === 'direct-ui') {
        return await prepareDirectUiCandidate({
            dependencies: input.dependencies,
            accountLifetime: input.accountLifetime,
            source: input.source,
            sourceContracts: input.sourceContracts,
            sourceIsCurrent: input.sourceIsCurrent,
            target: input.target,
            preparation: input.preparation,
        });
    }
    if (input.preparation.kind === 'direct-ui-target') {
        let resolved: Awaited<ReturnType<typeof input.preparation.resolve>>;
        try {
            resolved = await input.preparation.resolve(Object.freeze({
                accountLifetime: input.accountLifetime,
                isCurrent: input.sourceIsCurrent,
            }));
        } catch {
            return Object.freeze({ kind: 'unavailable', code: 'candidate_preparation_unavailable' });
        }
        if (resolved.kind !== 'available') {
            return Object.freeze({ kind: 'unavailable', code: 'candidate_preparation_unavailable' });
        }
        if (
            resolved.candidateTarget.release.pluginId !== input.target.release.pluginId
            || resolved.candidateTarget.release.version !== input.target.release.version
        ) {
            return Object.freeze({ kind: 'unavailable', code: 'target_contract_mismatch' });
        }
        return await prepareDirectUiCandidate({
            dependencies: input.dependencies,
            accountLifetime: input.accountLifetime,
            source: input.source,
            sourceContracts: input.sourceContracts,
            sourceIsCurrent: input.sourceIsCurrent,
            target: input.target,
            preparation: Object.freeze({
                kind: 'direct-ui' as const,
                candidateTarget: Object.freeze({
                    artifact: resolved.candidateTarget.artifact,
                    availabilityCursor: resolved.candidateTarget.availabilityCursor,
                }),
                artifact: resolved.artifact,
            }),
        });
    }
    try {
        return await input.preparation.prepare(Object.freeze({
            source: Object.freeze({
                release: input.source.release.ref,
                collectionContracts: input.sourceContracts,
            }),
            target: Object.freeze({
                release: input.target.release,
                collectionContracts: input.target.collectionContracts,
            }),
            accountLifetime: input.accountLifetime,
            isCurrent: input.sourceIsCurrent,
        }));
    } catch {
        return Object.freeze({ kind: 'unavailable', code: 'candidate_preparation_unavailable' });
    }
}

/**
 * Direct UI's one present-user Account release-selection vertical. It first
 * sends the exact Availability intent CAS. Only the server's exact
 * preparation-required refusal permits loading candidate callbacks and asking
 * the Data owner to prepare existing source Collections before one retry.
 * Machine installation/trust is intentionally absent.
 */
export function createCandidateCollectionReleaseSelector(
    overrides: Partial<CandidateCollectionReleaseSelectionDependencies> = {},
): Readonly<{
    select: (input: Readonly<{
        /** Required only when Availability explicitly requires preparation. */
        reader?: PluginAccountAvailabilityReader;
        accountLifetime: ActiveServerAccountScopeLifetime;
        target: CandidateCollectionReleaseSelectionTarget;
        /** Present-user action lifetime; distinct from the Account lifetime. */
        isCurrent?: () => boolean;
    }>) => Promise<CandidateCollectionReleaseSelectionResult>;
}> {
    const dependencies: CandidateCollectionReleaseSelectionDependencies = {
        ...defaultDependencies(),
        ...overrides,
    };
    return Object.freeze({
        select: async (input) => {
            if (!actionIsCurrent(input)) {
                return Object.freeze({ kind: 'cancelled' });
            }
            if (!input.accountLifetime.isCurrent()) {
                return Object.freeze({ kind: 'unavailable', code: 'source_release_unavailable' });
            }
            const targetIntent = createTargetIntentSetInput(input.target);
            const initialSet = await dependencies.setIntent(targetIntent);
            if (!actionIsCurrent(input)) {
                return Object.freeze({ kind: 'cancelled' });
            }
            const initialResult = selectionResultForSettledIntent(initialSet);
            if (initialResult) return initialResult;

            const reader = input.reader;
            if (!reader || !input.accountLifetime.isCurrent()) {
                return Object.freeze({ kind: 'unavailable', code: 'source_release_unavailable' });
            }
            const source = reader.readCurrentReleaseSelection({
                pluginId: input.target.release.pluginId,
            });
            if (source.kind !== 'available') {
                return Object.freeze({ kind: 'unavailable', code: 'source_release_unavailable' });
            }
            const sourceContracts = normalizePluginAccountCollectionContractsV1({
                pluginId: source.release.ref.pluginId,
                contributions: source.release.normalizedManifest.contributes.accountCollections,
            });
            const sourceRefs = sourceContracts.map((contract) => ({
                pluginId: contract.pluginId,
                collectionId: contract.collectionId,
                schemaVersion: contract.schemaVersion,
                contractDigest: contract.contractDigest,
            }));
            if (!sameRefSet(sourceRefs, source.intent.writableCollections)) {
                return Object.freeze({ kind: 'unavailable', code: 'source_release_unavailable' });
            }
            if (source.intent.revision !== targetIntent.expectedRevision) {
                return Object.freeze({ kind: 'conflict', code: 'intent_revision_conflict' });
            }
            const sourceIsCurrent = () => actionIsCurrent(input)
                && input.accountLifetime.isCurrent()
                && sameSourceSelection(reader, source);
            const preparation = input.target.preparation;
            if (!preparation) {
                return Object.freeze({ kind: 'unavailable', code: 'candidate_preparation_unavailable' });
            }
            const prepared = await prepareCandidateCollectionRelease({
                dependencies,
                accountLifetime: input.accountLifetime,
                source,
                sourceContracts,
                sourceIsCurrent,
                target: input.target,
                preparation,
            });
            if (!actionIsCurrent(input)) {
                if (prepared.kind === 'prepared') await retirePreparedStage(prepared.stage);
                return Object.freeze({ kind: 'cancelled' });
            }
            if (!sourceIsCurrent()) {
                if (prepared.kind === 'prepared') await retirePreparedStage(prepared.stage);
                return Object.freeze({ kind: 'unavailable', code: 'source_release_changed' });
            }
            if (prepared.kind !== 'prepared') {
                return Object.freeze({ kind: 'unavailable', code: prepared.code });
            }
            const retrySet = await dependencies.setIntent(targetIntent);
            if (!actionIsCurrent(input)) {
                await retirePreparedStage(prepared.stage);
                return Object.freeze({ kind: 'cancelled' });
            }
            if (!sourceIsCurrent()) {
                await retirePreparedStage(prepared.stage);
                return Object.freeze({ kind: 'unavailable', code: 'source_release_changed' });
            }
            const retryResult = selectionResultForSettledIntent(retrySet);
            if (retryResult) {
                if (retrySet.kind === 'rejected') {
                    await retirePreparedStage(prepared.stage);
                }
                return retryResult;
            }
            // The server's one preparation-required refusal authorizes exactly
            // one preparation pass and one retry. Retain its exact stages for
            // the canonical Availability owner to reconcile; never replay code.
            return Object.freeze({ kind: 'unavailable', code: 'intent_set_unavailable' });
        },
    });
}

const installedCandidateCollectionReleaseSelector = createCandidateCollectionReleaseSelector();

export async function selectCandidateCollectionRelease(input: Readonly<{
    reader?: PluginAccountAvailabilityReader;
    accountLifetime: ActiveServerAccountScopeLifetime;
    target: CandidateCollectionReleaseSelectionTarget;
    isCurrent?: () => boolean;
}>): Promise<CandidateCollectionReleaseSelectionResult> {
    return await installedCandidateCollectionReleaseSelector.select(input);
}
