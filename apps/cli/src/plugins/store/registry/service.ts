import type { PluginRegistryCommitResult } from './commitCoordinator';
import type { PluginRegistryCommitRecord } from './commitRecord';

type CommitCoordinator = Readonly<{
  readCurrent: () => Promise<PluginRegistryCommitRecord | null>;
  commit: (input: Readonly<{
    transactionId: string;
    baseRevision: number | null;
    signal?: AbortSignal;
    buildNext: (current: PluginRegistryCommitRecord | null) => PluginRegistryCommitRecord | Promise<PluginRegistryCommitRecord>;
  }>) => Promise<PluginRegistryCommitResult>;
}>;

export type PluginRegistryTransactionResult =
  | Readonly<{
      status: 'committed';
      record: PluginRegistryCommitRecord;
      applied: true;
      appliedGenerationsByPluginId?: Readonly<Record<string, string | null>>;
      pendingSurfaces: readonly PluginRegistryPendingSurface[];
      message?: string;
    }>
  | Readonly<{
      status: 'outcomeUnknown';
      record: PluginRegistryCommitRecord;
      phase: 'durability' | 'adoption';
      message: string;
    }>
  | Readonly<{ status: 'conflict'; expectedRevision: number | null; actualRevision: number | null; abortMessage?: string }>
  | Readonly<{ status: 'aborted'; reason: 'signal'; abortMessage?: string }>
  | Readonly<{
      status: 'precommit_failed';
      phase: 'prepare' | 'validateAndActivate' | 'readCurrent' | 'persist' | 'commit';
      message: string;
      abortMessage?: string;
    }>;

export type PluginRegistryPendingSurface =
  | 'reconciliation'
  | 'retirement'
  | 'cleanup';

type TransactionOperation<TPrepared, TActivated> = Readonly<{
  transactionId: string;
  baseRevision: number | null;
  signal?: AbortSignal;
  prepare: () => Promise<TPrepared>;
  validateAndActivate: (prepared: TPrepared) => Promise<TActivated>;
  persist: (prepared: TPrepared, current: PluginRegistryCommitRecord | null) => Promise<PluginRegistryCommitRecord>;
  abortPrepared: (prepared: TPrepared, activated: TActivated | undefined) => Promise<void>;
  adopt: (
    record: PluginRegistryCommitRecord,
    activated: TActivated,
  ) => Promise<Readonly<Record<string, string | null>> | void>;
  reconcile: (record: PluginRegistryCommitRecord) => Promise<Readonly<{
    status: 'reconciled' | 'retryable';
    message?: string;
  }>>;
  retirePrevious: (record: PluginRegistryCommitRecord) => Promise<void>;
  cleanup: (record: PluginRegistryCommitRecord) => Promise<void>;
  retainActivatedOnConflict?: boolean;
}>;

export type PluginRegistryTransactionExecutionResult<TActivated> =
  | PluginRegistryTransactionResult
  | (Extract<PluginRegistryTransactionResult, { status: 'conflict' }> & Readonly<{
      retryActivation: TActivated;
    }>);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createPluginRegistryTransactionService(input: Readonly<{
  coordinator: CommitCoordinator;
}>): Readonly<{
  execute: <TPrepared, TActivated>(
    operation: TransactionOperation<TPrepared, TActivated>,
  ) => Promise<PluginRegistryTransactionExecutionResult<TActivated>>;
}> {
  function execute<TPrepared, TActivated>(
    operation: TransactionOperation<TPrepared, TActivated>,
  ): Promise<PluginRegistryTransactionExecutionResult<TActivated>> {
    return (async (): Promise<PluginRegistryTransactionExecutionResult<TActivated>> => {
      let prepared: TPrepared;
      try {
        prepared = await operation.prepare();
      } catch (error) {
        return { status: 'precommit_failed', phase: 'prepare', message: errorMessage(error) };
      }

      let activation: Readonly<{ value: TActivated }> | null = null;
      let aborted = false;
      async function abortOnce(): Promise<string | undefined> {
        if (aborted) return undefined;
        aborted = true;
        try {
          await operation.abortPrepared(prepared, activation?.value);
          return undefined;
        } catch (error) {
          return errorMessage(error);
        }
      }

      try {
        activation = { value: await operation.validateAndActivate(prepared) };
      } catch (error) {
        const abortMessage = await abortOnce();
        return {
          status: 'precommit_failed', phase: 'validateAndActivate', message: errorMessage(error),
          ...(abortMessage ? { abortMessage } : {}),
        };
      }

      let current: PluginRegistryCommitRecord | null;
      try {
        current = await input.coordinator.readCurrent();
      } catch (error) {
        const abortMessage = await abortOnce();
        return {
          status: 'precommit_failed', phase: 'readCurrent', message: errorMessage(error),
          ...(abortMessage ? { abortMessage } : {}),
        };
      }
      const actualRevision = current?.revision ?? null;
      if (actualRevision !== operation.baseRevision) {
        if (operation.retainActivatedOnConflict && activation) {
          return {
            status: 'conflict',
            expectedRevision: operation.baseRevision,
            actualRevision,
            retryActivation: activation.value,
          };
        }
        const abortMessage = await abortOnce();
        return {
          status: 'conflict', expectedRevision: operation.baseRevision, actualRevision,
          ...(abortMessage ? { abortMessage } : {}),
        };
      }

      let next: PluginRegistryCommitRecord;
      try {
        next = await operation.persist(prepared, current);
      } catch (error) {
        const abortMessage = await abortOnce();
        return {
          status: 'precommit_failed', phase: 'persist', message: errorMessage(error),
          ...(abortMessage ? { abortMessage } : {}),
        };
      }

      let commitResult: PluginRegistryCommitResult;
      try {
        commitResult = await input.coordinator.commit({
          transactionId: operation.transactionId,
          baseRevision: operation.baseRevision,
          ...(operation.signal ? { signal: operation.signal } : {}),
          buildNext: () => next,
        });
      } catch (error) {
        const abortMessage = await abortOnce();
        return {
          status: 'precommit_failed', phase: 'commit', message: errorMessage(error),
          ...(abortMessage ? { abortMessage } : {}),
        };
      }
      if (commitResult.status === 'committed_durability_pending') {
        if (!activation) {
          return {
            status: 'outcomeUnknown',
            record: commitResult.record,
            phase: 'adoption',
            message: 'Plugin registry transaction reached durability ambiguity without an activated candidate',
          };
        }
        try {
          await operation.adopt(commitResult.record, activation.value);
        } catch (error) {
          return {
            status: 'outcomeUnknown',
            record: commitResult.record,
            phase: 'adoption',
            message: errorMessage(error),
          };
        }
        return {
          status: 'outcomeUnknown',
          record: commitResult.record,
          phase: 'durability',
          message: commitResult.message,
        };
      }
      if (commitResult.status !== 'committed') {
        if (
          commitResult.status === 'conflict'
          && operation.retainActivatedOnConflict
          && activation
        ) {
          return { ...commitResult, retryActivation: activation.value };
        }
        const abortMessage = await abortOnce();
        return { ...commitResult, ...(abortMessage ? { abortMessage } : {}) };
      }

      const record = commitResult.record;
      if (!activation) {
        return {
          status: 'outcomeUnknown',
          record,
          phase: 'adoption',
          message: 'Plugin registry transaction reached adoption without an activated candidate',
        };
      }
      let appliedGenerationsByPluginId: Readonly<Record<string, string | null>> | undefined;
      try {
        appliedGenerationsByPluginId =
          await operation.adopt(record, activation.value) ?? undefined;
      } catch (error) {
        return {
          status: 'outcomeUnknown',
          record,
          phase: 'adoption',
          message: errorMessage(error),
        };
      }
      try {
        const reconciliation = await operation.reconcile(record);
        if (reconciliation.status !== 'reconciled') {
          return {
            status: 'committed',
            record,
            applied: true,
            ...(appliedGenerationsByPluginId ? { appliedGenerationsByPluginId } : {}),
            pendingSurfaces: Object.freeze(['reconciliation']),
            message: reconciliation.message ?? 'Registry reconciliation is retryable',
          };
        }
      } catch (error) {
        return {
          status: 'committed', record, applied: true,
          ...(appliedGenerationsByPluginId ? { appliedGenerationsByPluginId } : {}),
          pendingSurfaces: Object.freeze(['reconciliation']), message: errorMessage(error),
        };
      }
      try {
        await operation.retirePrevious(record);
      } catch (error) {
        return {
          status: 'committed', record, applied: true,
          ...(appliedGenerationsByPluginId ? { appliedGenerationsByPluginId } : {}),
          pendingSurfaces: Object.freeze(['retirement']), message: errorMessage(error),
        };
      }
      try {
        await operation.cleanup(record);
      } catch (error) {
        return {
          status: 'committed', record, applied: true,
          ...(appliedGenerationsByPluginId ? { appliedGenerationsByPluginId } : {}),
          pendingSurfaces: Object.freeze(['cleanup']), message: errorMessage(error),
        };
      }
      return {
        status: 'committed',
        record,
        applied: true,
        ...(appliedGenerationsByPluginId ? { appliedGenerationsByPluginId } : {}),
        pendingSurfaces: Object.freeze([]),
      };
    })();
  }

  return Object.freeze({ execute });
}
