import {
    PLUGIN_COLLECTION_CANDIDATE_PREPARATION_RETIRE_HTTP_PATH_V1,
    PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1,
    PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1,
    PLUGIN_DATA_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    PluginCollectionCandidatePreparationBindingV1Schema,
    PluginCollectionCandidatePreparationErrorV1Schema,
    PluginCollectionCandidatePreparationRetireRequestV1Schema,
    PluginCollectionCandidatePreparationRetireResultV1Schema,
    PluginCollectionCandidatePreparationSourcePageRequestV1Schema,
    PluginCollectionCandidatePreparationSourcePageResultV1Schema,
    PluginCollectionCandidatePreparationStageRequestV1Schema,
    PluginCollectionCandidatePreparationStageResultV1Schema,
    compilePluginJsonSchema,
    measurePluginCollectionCandidatePreparationStageRequestEncodedBytesV1,
    type NormalizedPluginAccountCollectionContractV1,
    type PluginCollectionCandidatePreparationBindingV1,
    type PluginCollectionCandidatePreparationErrorV1,
    type PluginCollectionCandidatePreparationSourcePageResultV1,
    type PluginCollectionCandidatePreparationStageRequestV1,
    type PluginDataCollectionsCapabilities,
} from '@happier-dev/protocol';
import type {
    JsonValue,
    PluginAccountCollectionMigrationRuntimeProjection,
} from '@happier-dev/plugin-sdk';
import type { PluginAccountCollectionMigration } from '@happier-dev/plugin-sdk/collections';

import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getCachedServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import {
    withAccountStoredContentCompatibilityRequestDeclaration,
} from '@/sync/http/accountStoredContentCompatibility';

import {
    contractMatchesRef,
    encodePluginCollectionLogicalValue,
    getPreparedCollectionOperationCurrentness,
    mergeLogicalRow,
    prepareCollectionOperation,
    requestCollectionOperation,
    type ActivePluginCollectionUnavailableReasonV1,
    type EncodedPluginCollectionLogicalValueV1,
    type PreparedCollectionOperation,
} from './activePluginCollectionClient';

/**
 * Host-private prospective candidate authority. The producer must obtain it
 * from the exact prospective artifact/module loader; it is not a release
 * resolver, a machine-install projection, or a synchronized generation type.
 */
export type CollectionMigrationCandidateHandle = Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime;
    binding: PluginCollectionCandidatePreparationBindingV1;
    sourceContract: NormalizedPluginAccountCollectionContractV1;
    targetContract: NormalizedPluginAccountCollectionContractV1;
    collectionMigrations: PluginAccountCollectionMigrationRuntimeProjection;
    isCurrent(): boolean;
}>;

export type ActivePluginCollectionCandidatePreparationOutcomeV1 =
    | Readonly<{ kind: 'prepared' }>
    | Readonly<{ kind: 'retryable'; code: 'source_changed' }>
    | Readonly<{
        kind: 'unavailable';
        code: ActivePluginCollectionUnavailableReasonV1
            | 'candidate_generation_changed'
            | 'candidate_retired'
            | 'candidate_contract_unavailable'
            | 'retire_transport_unavailable';
    }>
    | Readonly<{
        kind: 'rejected';
        code: string;
        error?: PluginCollectionCandidatePreparationErrorV1;
    }>;

export type ActivePluginCollectionCandidateRetirementOutcomeV1 =
    | Readonly<{ kind: 'retired' }>
    | Exclude<ActivePluginCollectionCandidatePreparationOutcomeV1, Readonly<{ kind: 'prepared' }>>;

export type ActivePluginCollectionCandidatePreparationV1 = Readonly<{
    prepare(): Promise<ActivePluginCollectionCandidatePreparationOutcomeV1>;
    /**
     * Candidate-host teardown only. It first blocks new callback/stage work,
     * drains work already started by this object, then retires this exact
     * binding with the authority captured while its Account was current.
     */
    retire(): Promise<ActivePluginCollectionCandidateRetirementOutcomeV1>;
}>;

type CandidatePreparationFailure = Exclude<
    ActivePluginCollectionCandidatePreparationOutcomeV1,
    Readonly<{ kind: 'prepared' }>
>;

type InitializedCandidatePreparation = Readonly<{
    operation: PreparedCollectionOperation;
    accountRetirement: Readonly<{ dispose(): void }>;
}>;

type CandidatePreparationInitialization =
    | Readonly<{ kind: 'ready'; value: InitializedCandidatePreparation }>
    | Readonly<{ kind: 'failed'; outcome: CandidatePreparationFailure }>;

type CandidateRetirementReason = 'account' | 'candidate';

type CandidateStageItem = Readonly<{
    rowId: string;
    revision: number;
    content: EncodedPluginCollectionLogicalValueV1['content'];
    projection: EncodedPluginCollectionLogicalValueV1['projection'];
}>;

function createCandidateStageRequest(input: Readonly<{
    binding: PluginCollectionCandidatePreparationBindingV1;
    items: readonly CandidateStageItem[];
}>): PluginCollectionCandidatePreparationStageRequestV1 {
    return PluginCollectionCandidatePreparationStageRequestV1Schema.parse({
        binding: input.binding,
        items: input.items.map((item) => ({
            source: { rowId: item.rowId, revision: item.revision },
            target: { content: item.content, projection: item.projection },
        })),
    });
}

function splitCandidateStageRequestsForKnownLimits(input: Readonly<{
    binding: PluginCollectionCandidatePreparationBindingV1;
    items: readonly CandidateStageItem[];
    limits: Pick<PluginDataCollectionsCapabilities, 'maxBatchRows' | 'maxBatchBytes'>;
}>): readonly PluginCollectionCandidatePreparationStageRequestV1[] {
    const requests: PluginCollectionCandidatePreparationStageRequestV1[] = [];
    let pending: CandidateStageItem[] = [];
    for (const item of input.items) {
        const candidate = createCandidateStageRequest({
            binding: input.binding,
            items: [...pending, item],
        });
        const exceedsKnownLimit = candidate.items.length > input.limits.maxBatchRows
            || measurePluginCollectionCandidatePreparationStageRequestEncodedBytesV1(candidate)
                > input.limits.maxBatchBytes;
        if (exceedsKnownLimit && pending.length > 0) {
            requests.push(createCandidateStageRequest({ binding: input.binding, items: pending }));
            pending = [item];
        } else {
            // A singleton that cannot fit has no smaller valid request shape.
            // Preserve the server's authoritative typed deployment-limit result.
            pending.push(item);
        }
    }
    if (pending.length > 0) {
        requests.push(createCandidateStageRequest({ binding: input.binding, items: pending }));
    }
    return requests;
}

function unavailable(
    code: Extract<ActivePluginCollectionCandidatePreparationOutcomeV1, { kind: 'unavailable' }>['code'],
): Extract<ActivePluginCollectionCandidatePreparationOutcomeV1, { kind: 'unavailable' }> {
    return { kind: 'unavailable', code };
}

function rejected(
    code: string,
    error?: PluginCollectionCandidatePreparationErrorV1,
): Extract<ActivePluginCollectionCandidatePreparationOutcomeV1, { kind: 'rejected' }> {
    return {
        kind: 'rejected',
        code,
        ...(error ? { error } : {}),
    };
}

function sameMigrationIdentity(
    left: Pick<PluginAccountCollectionMigration, 'id' | 'fromSchemaVersion' | 'toSchemaVersion'>,
    right: Pick<PluginAccountCollectionMigration, 'id' | 'fromSchemaVersion' | 'toSchemaVersion'>,
): boolean {
    return left.id === right.id
        && left.fromSchemaVersion === right.fromSchemaVersion
        && left.toSchemaVersion === right.toSchemaVersion;
}

function resolveMigrationChain(input: Readonly<{
    source: NormalizedPluginAccountCollectionContractV1;
    target: NormalizedPluginAccountCollectionContractV1;
    candidate: CollectionMigrationCandidateHandle;
}>): readonly PluginAccountCollectionMigration[] | null {
    const runtimeMigrations = input.candidate.collectionMigrations[input.target.collectionId] ?? [];
    if (runtimeMigrations.length !== input.target.migrations.length
        || runtimeMigrations.some((migration, index) => (
            !sameMigrationIdentity(migration, input.target.migrations[index]!)
        ))) {
        return null;
    }

    const sourcePosition = input.target.readableSchemaVersions.indexOf(input.source.schemaVersion);
    if (sourcePosition < 0) return null;
    const chain = runtimeMigrations.slice(sourcePosition);
    let currentVersion = input.source.schemaVersion;
    for (const migration of chain) {
        if (migration.fromSchemaVersion !== currentVersion) return null;
        currentVersion = migration.toSchemaVersion;
    }
    return currentVersion === input.target.schemaVersion ? chain : null;
}

function mapCandidatePreparationError(value: unknown): CandidatePreparationFailure {
    const parsed = PluginCollectionCandidatePreparationErrorV1Schema.safeParse(value);
    if (!parsed.success) return unavailable('response-invalid');
    if (parsed.data.error === 'collection_candidate_preparation_source_changed') {
        return { kind: 'retryable', code: 'source_changed' };
    }
    return rejected(parsed.data.error, parsed.data);
}

/**
 * The UI's direct candidate-preparation owner. It reuses the existing active
 * Collection operation, logical decoder, logical encoder, scoped Account
 * authority, and Account lifetime rather than creating a second Data owner.
 */
export function createActivePluginCollectionCandidatePreparation(input: Readonly<{
    candidate: CollectionMigrationCandidateHandle;
}>): ActivePluginCollectionCandidatePreparationV1 {
    const binding = PluginCollectionCandidatePreparationBindingV1Schema.safeParse(input.candidate.binding);
    let retirementReason: CandidateRetirementReason | null = null;
    const workAbort = new AbortController();
    let initialization: Promise<CandidatePreparationInitialization> | null = null;
    let running: Promise<ActivePluginCollectionCandidatePreparationOutcomeV1> | null = null;
    let retirement: Promise<ActivePluginCollectionCandidateRetirementOutcomeV1> | null = null;

    const currentness = (
        operation?: PreparedCollectionOperation,
    ): Extract<ActivePluginCollectionCandidatePreparationOutcomeV1, { kind: 'unavailable' }>['code'] | null => {
        if (!input.candidate.accountLifetime.isCurrent() || retirementReason === 'account') {
            return 'account-scope-changed';
        }
        if (retirementReason === 'candidate') return 'candidate_retired';
        if (!input.candidate.isCurrent()) return 'candidate_generation_changed';
        if (!operation) return null;
        const operationCurrentness = getPreparedCollectionOperationCurrentness(operation);
        if (operationCurrentness) return operationCurrentness;
        if (operation.signal.aborted) return 'operation-cancelled';
        return null;
    };

    const operationUnavailable = (
        reason: ActivePluginCollectionUnavailableReasonV1,
        operation?: PreparedCollectionOperation,
    ): Extract<ActivePluginCollectionCandidatePreparationOutcomeV1, { kind: 'unavailable' }> => {
        const stale = currentness(operation);
        return unavailable(stale ?? reason);
    };

    const readKnownCollectionLimits = (
        operation: PreparedCollectionOperation,
    ): PluginDataCollectionsCapabilities | undefined => {
        const featureSnapshot = getCachedServerFeaturesSnapshot({
            serverId: operation.serverSnapshot.serverId,
        });
        return featureSnapshot?.status === 'ready'
            ? featureSnapshot.features.capabilities.pluginDataCollections
            : undefined;
    };

    const ensureInitialized = async (): Promise<CandidatePreparationInitialization> => {
        if (initialization) return await initialization;
        initialization = (async () => {
            if (!binding.success) return {
                kind: 'failed',
                outcome: rejected('collection_candidate_preparation_invalid'),
            };
            const before = currentness();
            if (before) return { kind: 'failed', outcome: unavailable(before) };
            const prepared = await prepareCollectionOperation(
                { signal: workAbort.signal },
                input.candidate.accountLifetime,
            );
            if (prepared.status === 'unavailable') {
                return { kind: 'failed', outcome: operationUnavailable(prepared.reason) };
            }
            const after = currentness(prepared.operation);
            if (after) {
                prepared.operation.release();
                return { kind: 'failed', outcome: unavailable(after) };
            }
            const accountRetirement = input.candidate.accountLifetime.onRetire(() => {
                void retireInternal('account');
            });
            return {
                kind: 'ready',
                value: {
                    operation: prepared.operation,
                    accountRetirement,
                },
            };
        })();
        return await initialization;
    };

    const requestSourcePage = async (inputPage: Readonly<{
        operation: PreparedCollectionOperation;
        cursor?: string;
    }>): Promise<
        | Readonly<{ kind: 'ready'; page: PluginCollectionCandidatePreparationSourcePageResultV1 }>
        | CandidatePreparationFailure
    > => {
        const before = currentness(inputPage.operation);
        if (before) return unavailable(before);
        const request = PluginCollectionCandidatePreparationSourcePageRequestV1Schema.safeParse({
            binding: binding.success ? binding.data : input.candidate.binding,
            ...(inputPage.cursor ? { cursor: inputPage.cursor } : {}),
            limit: 50,
        });
        if (!request.success) return rejected('collection_candidate_preparation_invalid');
        const response = await requestCollectionOperation({
            operation: inputPage.operation,
            path: PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1,
            body: request.data,
        });
        if (response.status === 'unavailable') return operationUnavailable(response.reason, inputPage.operation);
        const after = currentness(inputPage.operation);
        if (after) return unavailable(after);
        if (!response.ok) return mapCandidatePreparationError(response.body);
        const parsed = PluginCollectionCandidatePreparationSourcePageResultV1Schema.safeParse(response.body);
        if (!parsed.success) return unavailable('response-invalid');
        return { kind: 'ready', page: parsed.data };
    };

    const requestStageBatch = async (inputStage: Readonly<{
        operation: PreparedCollectionOperation;
        items: readonly CandidateStageItem[];
    }>): Promise<
        | Readonly<{ kind: 'staged' }>
        | CandidatePreparationFailure
    > => {
        const before = currentness(inputStage.operation);
        if (before) return unavailable(before);
        let requests: readonly PluginCollectionCandidatePreparationStageRequestV1[];
        try {
            const exactBinding = binding.success ? binding.data : input.candidate.binding;
            const collectionLimits = readKnownCollectionLimits(inputStage.operation);
            requests = collectionLimits
                ? splitCandidateStageRequestsForKnownLimits({
                    binding: exactBinding,
                    items: inputStage.items,
                    limits: collectionLimits,
                })
                : [createCandidateStageRequest({
                    binding: exactBinding,
                    items: inputStage.items,
                })];
        } catch {
            return rejected('collection_candidate_preparation_invalid');
        }
        for (const request of requests) {
            const beforeRequest = currentness(inputStage.operation);
            if (beforeRequest) return unavailable(beforeRequest);
            const response = await requestCollectionOperation({
                operation: inputStage.operation,
                path: PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1,
                body: request,
            });
            if (response.status === 'unavailable') return operationUnavailable(response.reason, inputStage.operation);
            const after = currentness(inputStage.operation);
            if (after) return unavailable(after);
            if (!response.ok) return mapCandidatePreparationError(response.body);
            const parsed = PluginCollectionCandidatePreparationStageResultV1Schema.safeParse(response.body);
            if (!parsed.success || parsed.data.results.length !== request.items.length) {
                return unavailable('response-invalid');
            }
            if (parsed.data.results.some((result) => result.status === 'sourceChanged')) {
                return { kind: 'retryable', code: 'source_changed' };
            }
        }
        return { kind: 'staged' };
    };

    const runPreparation = async (): Promise<ActivePluginCollectionCandidatePreparationOutcomeV1> => {
        try {
            const initialized = await ensureInitialized();
            if (initialized.kind === 'failed') return initialized.outcome;
            const operation = initialized.value.operation;
            const beforeContracts = currentness(operation);
            if (beforeContracts) return unavailable(beforeContracts);
            if (!binding.success
                || !contractMatchesRef(input.candidate.sourceContract, binding.data.source)
                || !contractMatchesRef(input.candidate.targetContract, binding.data.target)) {
                return rejected('collection_candidate_preparation_contract_mismatch');
            }
            const migrations = resolveMigrationChain({
                source: input.candidate.sourceContract,
                target: input.candidate.targetContract,
                candidate: input.candidate,
            });
            if (!migrations) return rejected('collection_candidate_preparation_contract_mismatch');
            const sourceValidate = compilePluginJsonSchema(input.candidate.sourceContract.schema);
            const targetValidate = compilePluginJsonSchema(input.candidate.targetContract.schema);

            let cursor: string | undefined;
            do {
                const page = await requestSourcePage({ operation, ...(cursor ? { cursor } : {}) });
                if (page.kind !== 'ready') return page;
                const stageItems: CandidateStageItem[] = [];
                for (const row of page.page.rows) {
                    const beforeRow = currentness(operation);
                    if (beforeRow) return unavailable(beforeRow);
                    if (row.alreadyStaged) continue;
                    const source = mergeLogicalRow<Readonly<Record<string, JsonValue>>>({
                        contract: input.candidate.sourceContract,
                        validate: sourceValidate,
                        row,
                        encryptionMode: operation.encryptionMode,
                        material: operation.material,
                    });
                    if (!source) return rejected('collection_candidate_preparation_source_invalid');
                    let value: Readonly<Record<string, JsonValue>> = source.value;
                    try {
                        for (const migration of migrations) {
                            const beforeCallback = currentness(operation);
                            if (beforeCallback) return unavailable(beforeCallback);
                            value = await migration.migrate(value);
                            const afterCallback = currentness(operation);
                            if (afterCallback) return unavailable(afterCallback);
                        }
                    } catch {
                        return rejected('collection_candidate_preparation_callback_failed');
                    }
                    const encoded = encodePluginCollectionLogicalValue({
                        contract: input.candidate.targetContract,
                        validate: targetValidate,
                        value,
                        encryptionMode: operation.encryptionMode,
                        material: operation.material,
                    });
                    if (!encoded) return rejected('collection_candidate_preparation_callback_invalid');
                    const beforeStage = currentness(operation);
                    if (beforeStage) return unavailable(beforeStage);
                    stageItems.push({
                        rowId: row.rowId,
                        revision: row.revision,
                        content: encoded.content,
                        projection: encoded.projection,
                    });
                }
                if (stageItems.length > 0) {
                    const staged = await requestStageBatch({ operation, items: stageItems });
                    if (staged.kind !== 'staged') return staged;
                }
                cursor = page.page.nextCursor;
            } while (cursor);
            const afterPages = currentness(operation);
            return afterPages ? unavailable(afterPages) : { kind: 'prepared' };
        } catch {
            return unavailable('transport-unavailable');
        }
    };

    async function retireInternal(
        reason: CandidateRetirementReason,
    ): Promise<ActivePluginCollectionCandidateRetirementOutcomeV1> {
        if (retirement) return await retirement;
        if (!retirementReason) retirementReason = reason;
        workAbort.abort();
        retirement = (async () => {
            const activeRun = running;
            if (activeRun) await activeRun;
            const initializationResult = initialization ? await initialization : null;
            if (!initializationResult || initializationResult.kind === 'failed') return { kind: 'retired' };
            const { operation, accountRetirement } = initializationResult.value;
            try {
                const request = PluginCollectionCandidatePreparationRetireRequestV1Schema.safeParse({
                    binding: binding.success ? binding.data : input.candidate.binding,
                });
                if (!request.success) return rejected('collection_candidate_preparation_invalid');
                const response = await operation.authority.request(
                    PLUGIN_COLLECTION_CANDIDATE_PREPARATION_RETIRE_HTTP_PATH_V1,
                    withAccountStoredContentCompatibilityRequestDeclaration({
                        method: 'POST',
                        headers: operation.headers,
                        body: JSON.stringify(request.data),
                    }, PLUGIN_DATA_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
                );
                const body = await response.json().catch(() => null);
                if (!response.ok) return mapCandidatePreparationError(body);
                if (!PluginCollectionCandidatePreparationRetireResultV1Schema.safeParse(body).success) {
                    return unavailable('response-invalid');
                }
                return { kind: 'retired' };
            } catch {
                return unavailable('retire_transport_unavailable');
            } finally {
                accountRetirement.dispose();
                operation.release();
            }
        })();
        return await retirement;
    }

    return Object.freeze({
        prepare: async () => {
            if (running) return await running;
            const stale = currentness();
            if (stale) return unavailable(stale);
            const next = runPreparation();
            running = next;
            try {
                return await next;
            } finally {
                if (running === next) running = null;
            }
        },
        retire: async () => await retireInternal('candidate'),
    });
}
