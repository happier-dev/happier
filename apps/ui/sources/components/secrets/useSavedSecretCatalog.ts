import * as React from 'react';
import type { ScopedSnapshotError } from '@/sync/domains/scope/scopedSnapshotFacts';
import { useShallow } from 'zustand/react/shallow';
import {
  type SavedSecretCatalogCorruptEntryV1,
  type SavedSecretCatalogEntryV1,
} from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';

import { getStorage } from '@/sync/domains/state/storageStore';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { Modal } from '@/modal';
import { HappyError } from '@/utils/errors/errors';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';
import {
  awaitActionApprovalResult,
  type ActionApprovalRegistration,
} from '@/components/approvals/actionApprovalContinuation';
import { isTeamActionApprovalPendingError } from '@/sync/ops/teams/teamActionClient';
import { runTeamAction, type TeamActionOutcome } from '@/sync/ops/teams/teamActionClient';
import { homeDomainFailureFromActionFailure } from '@/sync/api/home/homeDomainActions';
import { PERSONAL_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1, PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1,
  type SavedSecretVaultTargetV1 } from '@happier-dev/protocol/account/settings/personalSavedSecretActionsV1';
import type { SavedSecretExternalSourceV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import {
  observeSavedSecretCatalog,
  refreshSavedSecretCatalog,
} from '@/sync/engine/settings/savedSecretCatalogEngine';
import {
  getUsableSavedSecrets,
  getMaterializedSavedSecrets,
  getSavedSecretCatalogSnapshot,
  readSavedSecretCatalogEntry,
  readSavedSecretCatalogName,
  resolveSavedSecretReference,
  subscribeSavedSecretCatalogSnapshots,
  type SavedSecretReferenceResolution,
  type SavedSecretCatalogNameReading,
} from '@/sync/store/settings/savedSecretCatalogSnapshot';
import {
  deleteSavedSecretResource,
  updateSavedSecretResource,
  projectSavedSecretResourceOperationFailure,
  projectSavedSecretResourceUpdateFailure,
  type SavedSecretCreationResult,
  type SavedSecretResourceDeleteResult,
} from '@/sync/ops/settings/savedSecretResourceOperations';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';

type SavedSecretCatalogCorruptOwnerEntry = Extract<
  SavedSecretCatalogCorruptEntryV1,
  Readonly<{ relationship: 'owner' }>
>;
type SavedSecretCreateActionResult = ReturnType<
  (typeof PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1)['secrets.create']['parse']
>;

/** A personal secret holds its value, or links to a field in a declared secret source (never both). */
export type SavedSecretPersonalCreateInput = Readonly<{ name: string; kind?: SavedSecret['kind'] }> & (
  | Readonly<{ value: string; storeIn?: SavedSecretVaultTargetV1 }>
  | Readonly<{ source: SavedSecretExternalSourceV1 }>
);

type VaultActionId = 'secrets.link' | 'secrets.export';
type VaultInput<T extends VaultActionId> = ReturnType<(typeof PERSONAL_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1)[T]['parse']>;
type VaultOutput<T extends VaultActionId> = ReturnType<(typeof PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1)[T]['parse']>;

export type SavedSecretPrivateCreationApprovalOptions = Readonly<{
  onApprovalPending: (registration: ActionApprovalRegistration) => void;
  /** The person rejected or canceled the approval: a decision, not a failure to present. */
  onApprovalDeclined?: () => void;
  signal?: AbortSignal;
}>;

export type SavedSecretCatalogProjection = Readonly<{
  sharedEnabled: boolean;
  personalSecrets: readonly SavedSecret[];
  personalMutationsAvailable: boolean;
  personalMutations: Readonly<{
    create: (
      input: SavedSecretPersonalCreateInput,
      approval?: SavedSecretPrivateCreationApprovalOptions,
    ) => Promise<string | null>;
    rename: (secret: SavedSecret, name?: string) => Promise<boolean>;
    rotate: (secret: SavedSecret, value?: string) => Promise<boolean>;
    delete: (secret: SavedSecret) => Promise<boolean>;
  }>;
  collisionMigrationStatus: 'not_required' | 'migrating' | 'failed';
  entries: readonly SavedSecretCatalogEntryV1[];
  sharedEntries: readonly SavedSecretCatalogEntryV1[];
  /** All resources keep their storage/access management metadata, including private resources. */
  updateResource: (
    input: Omit<Parameters<typeof updateSavedSecretResource>[0], 'scope'>,
  ) => ReturnType<typeof updateSavedSecretResource>;
  linkVaultItems: (input: VaultInput<'secrets.link'>, signal?: AbortSignal) => Promise<TeamActionOutcome<VaultOutput<'secrets.link'>>>;
  exportResourcesToVault: (input: VaultInput<'secrets.export'>, signal?: AbortSignal) => Promise<TeamActionOutcome<VaultOutput<'secrets.export'>>>;
  /** Selection rows retain private editing without reclassifying resource-management targets. */
  picker: Readonly<{
    personalSecrets: readonly SavedSecret[];
    sharedEntries: readonly SavedSecretCatalogEntryV1[];
  }>;
  corruptEntries: readonly SavedSecretCatalogCorruptEntryV1[];
  /**
   * The repair carries the owner reference census's own answer, so a resource
   * the owner's Settings still bind is reported as in use rather than as a
   * nameless failure the person cannot act on.
   */
  deleteCorruptResource: (
    entry: SavedSecretCatalogCorruptOwnerEntry,
  ) => Promise<SavedSecretResourceDeleteResult>;
  materializedSecrets: readonly SavedSecret[];
  usableSecrets: readonly SavedSecret[];
  resolveReference: (ref: string) => SavedSecretReferenceResolution;
  status: 'loading' | 'refreshing' | 'ready' | 'error';
  stale: boolean;
  error: boolean;
  errorCause: ScopedSnapshotError | null;
  reload: () => Promise<void>;
}>;

/**
 * The UI's one Saved Secret catalog.
 *
 * Private and granted resources come from the qualified Home. Legacy Settings
 * values are handled only by the catalog engine's source importer.
 */
function useSavedSecretCatalogSource(
  options?: Readonly<{
    scope?: AccountSettingsScope | null;
    includeMaterial?: boolean;
    /** A reader that has not consumed the catalog yet reads snapshots without creating load demand. */
    demanded?: boolean;
  }>,
) {
  const activeScope = useAccountSettingsScope();
  const scope =
    options && Object.prototype.hasOwnProperty.call(options, 'scope')
      ? (options.scope ?? null)
      : activeScope;
  const scopeIsActive = Boolean(
    scope &&
    activeScope &&
    scope.serverId === activeScope.serverId &&
    scope.accountId === activeScope.accountId,
  );
  const catalogEnabled = Boolean(scope);
  const serverId = scope?.serverId;
  const accountId = scope?.accountId;
  const includeMaterial = options?.includeMaterial !== false;
  const demanded = options?.demanded !== false;
  React.useEffect(() => {
    if (!serverId || !accountId || !catalogEnabled || !demanded) return;
    // The loader owns credential/currentness transitions. Equivalent
    // Settings scope objects must not retire its admitted material read.
    return observeSavedSecretCatalog(
      { serverId, accountId },
      { includeMaterial },
    );
  }, [serverId, accountId, catalogEnabled, includeMaterial, demanded]);

  return { scope, scopeIsActive, catalogEnabled, serverId, accountId };
}

/** Metadata labels subscribe to entries only; writers keep the complete catalog below. */
export function useSavedSecretCatalogEntries(
  options?: Readonly<{ scope?: AccountSettingsScope | null; refs?: readonly string[] }>,
) {
  const { scope, catalogEnabled, serverId, accountId } =
    useSavedSecretCatalogSource({ ...options, includeMaterial: false });
  const refsKey = options?.refs === undefined ? null : JSON.stringify(options.refs);
  const refs = React.useMemo((): readonly string[] | null => refsKey === null ? null : JSON.parse(refsKey), [refsKey]);
  const readShallow = useShallow(React.useCallback(
    () =>
      catalogEnabled
        ? refs === null ? (getSavedSecretCatalogSnapshot(scope)?.data ?? EMPTY_SHARED_ENTRIES)
          : refs.flatMap(ref => {
            const entry = readSavedSecretCatalogEntry(scope, ref);
            return entry ? [entry] : [];
          })
        : EMPTY_SHARED_ENTRIES,
    [serverId, accountId, catalogEnabled, scope, refs],
  ));
  const read = React.useCallback(() => readShallow(undefined), [readShallow]);
  const subscribe = React.useCallback((listener: () => void) => catalogEnabled
    ? subscribeSavedSecretCatalogSnapshots(listener, refs === null ? undefined : { scope, refs })
    : subscribeNoop(), [catalogEnabled, scope, refs]);
  return React.useSyncExternalStore(
    subscribe,
    read,
    read,
  );
}

/**
 * One Saved Secret's name for display, from the catalog's metadata alone (never material). `resolving` holds
 * while that scope's catalog is still being read; a reference the settled catalog does not list has no name.
 */
export function useSavedSecretCatalogName(
  ref: string | null,
  scope: AccountSettingsScope | null,
): SavedSecretCatalogNameReading {
  const { scope: source, catalogEnabled } = useSavedSecretCatalogSource({
    scope: ref ? scope : null,
    includeMaterial: false,
  });
  const subscribe = React.useCallback((listener: () => void) => ref && catalogEnabled
    ? subscribeSavedSecretCatalogSnapshots(listener, { scope: source, refs: [ref] })
    : subscribeNoop(), [source?.serverId, source?.accountId, ref, catalogEnabled]);
  const read = React.useCallback(() => readSavedSecretCatalogName(catalogEnabled ? source : null, ref ?? ''),
    [source?.serverId, source?.accountId, ref, catalogEnabled]);
  return React.useSyncExternalStore(subscribe, read, read);
}

export type SavedSecretReferenceReader = Readonly<{
  resolve: (ref: string) => SavedSecretReferenceResolution;
  /** Advances only when a reference this reader resolved changed; usable as a memo or check key. */
  revision: number;
}>;

function sameReferenceResolution(
  left: SavedSecretReferenceResolution,
  right: SavedSecretReferenceResolution,
): boolean {
  return left.status === right.status && left.displayStatus === right.displayStatus && left.resolving === right.resolving
    && left.errorCause === right.errorCause && left.kind === right.kind && left.entry === right.entry && left.secret === right.secret
    && left.revision === right.revision && left.fingerprint === right.fingerprint;
}

/**
 * Reference resolution for mounted readers that consume a few refs, not the inventory.
 * The reader changes only when a reference it resolved changes resolution; catalog
 * lifecycle, observation time and unrelated rows never re-render it. Resolution itself
 * remains `resolveSavedSecretReference`, so material authority is unchanged.
 */
export function useSavedSecretReferenceResolver(
  options?: Readonly<{ scope?: AccountSettingsScope | null; includeMaterial?: boolean }>,
): SavedSecretReferenceReader {
  // Demand follows consumption: only a resolved shared reference needs the Account catalog. A reader that
  // binds no Saved Secret (for example a revealed transcript row's Voice readiness) never loads it.
  const [demanded, setDemanded] = React.useState(false);
  const demandRef = React.useRef(false);
  const { scope, catalogEnabled, serverId, accountId } = useSavedSecretCatalogSource({ ...options, demanded });
  React.useEffect(() => { if (demandRef.current && !demanded) setDemanded(true); });
  const includeMaterial = options?.includeMaterial !== false;
  const source = catalogEnabled ? scope : null;
  const sourceRef = React.useRef(source);
  sourceRef.current = source;
  const readerRef = React.useRef<Readonly<{
    key: string;
    reader: SavedSecretReferenceReader;
    resolved: Map<string, SavedSecretReferenceResolution>;
  }> | null>(null);
  const key = JSON.stringify([catalogEnabled ? serverId : null, catalogEnabled ? accountId : null, includeMaterial]);
  const resolveNow = React.useCallback((ref: string) => {
    const resolution = resolveSavedSecretReference(sourceRef.current, EMPTY_MATERIALIZED_SECRETS, ref, { includeMaterial });
    if (resolution.kind === 'shared_resource' && sourceRef.current) demandRef.current = true;
    return resolution;
  }, [includeMaterial]);
  const createReader = React.useCallback((revision: number) => {
    const resolved = new Map<string, SavedSecretReferenceResolution>();
    const reader = Object.freeze({
      revision,
      resolve: (ref: string) => {
        const next = resolveNow(ref);
        const previous = resolved.get(ref);
        if (previous && sameReferenceResolution(previous, next)) return previous;
        resolved.set(ref, next);
        return next;
      },
    });
    return { key, reader, resolved };
  }, [key, resolveNow]);
  const read = React.useCallback(() => {
    const current = readerRef.current;
    if (!current || current.key !== key) {
      readerRef.current = createReader((current?.reader.revision ?? -1) + 1);
      return readerRef.current.reader;
    }
    for (const [ref, previous] of current.resolved) {
      if (sameReferenceResolution(previous, resolveNow(ref))) continue;
      readerRef.current = createReader(current.reader.revision + 1);
      return readerRef.current.reader;
    }
    return current.reader;
  }, [createReader, key, resolveNow]);
  return React.useSyncExternalStore(
    catalogEnabled ? subscribeSavedSecretCatalogSnapshots : subscribeNoop,
    read,
    read,
  );
}

/** Private resources the active Account may use, classified once for the full catalog and narrow readers. */
function projectPersonalSavedSecrets(
  entries: readonly SavedSecretCatalogEntryV1[],
  usableSecrets: readonly SavedSecret[],
): readonly SavedSecret[] {
  if (usableSecrets.length === 0) return EMPTY_MATERIALIZED_SECRETS;
  const privateRefs = new Set(
    entries
      .filter(
        (entry) =>
          entry.relationship === 'owner' &&
          entry.audience !== null &&
          entry.audience.accounts.length === 0 &&
          entry.audience.teams.length === 0 &&
          entry.audience.groups.length === 0 &&
          entry.capabilities.rename &&
          entry.capabilities.rotate &&
          entry.capabilities.delete,
      )
      .map((entry) => entry.ref),
  );
  return usableSecrets.filter((secret) => privateRefs.has(secret.id));
}

/** The private usable list alone; catalog lifecycle and unrelated rows never re-render its reader. */
export function useSavedSecretCatalogPersonalSecrets(
  options?: Readonly<{ scope?: AccountSettingsScope | null }>,
): readonly SavedSecret[] {
  const { scope, scopeIsActive, catalogEnabled, serverId, accountId } = useSavedSecretCatalogSource(options);
  const readShallow = useShallow(React.useCallback(
    () => catalogEnabled && scopeIsActive
      ? projectPersonalSavedSecrets(getSavedSecretCatalogSnapshot(scope)?.data ?? EMPTY_SHARED_ENTRIES,
        getUsableSavedSecrets(scope, EMPTY_MATERIALIZED_SECRETS))
      : EMPTY_MATERIALIZED_SECRETS,
    [serverId, accountId, catalogEnabled, scopeIsActive, scope],
  ));
  const read = React.useCallback(() => readShallow(undefined), [readShallow]);
  return React.useSyncExternalStore(
    catalogEnabled ? subscribeSavedSecretCatalogSnapshots : subscribeNoop,
    read,
    read,
  );
}

/** Select only the failure fact needed by a mounted reader; never load material for an error notice. */
export function useSavedSecretCatalogError(
  options?: Readonly<{ scope?: AccountSettingsScope | null }>,
): ScopedSnapshotError | null;
export function useSavedSecretCatalogError<T>(
  options: Readonly<{ scope?: AccountSettingsScope | null }> | undefined,
  select: (error: ScopedSnapshotError | null) => T,
): T;
export function useSavedSecretCatalogError<T>(
  options?: Readonly<{ scope?: AccountSettingsScope | null }>,
  select?: (error: ScopedSnapshotError | null) => T,
): T | ScopedSnapshotError | null {
  const { scope, catalogEnabled } = useSavedSecretCatalogSource({ ...options, includeMaterial: false });
  const readSelected = useShallow(React.useCallback(() => {
    const error = catalogEnabled ? getSavedSecretCatalogSnapshot(scope)?.error ?? null : null;
    return select ? select(error) : error;
  }, [scope?.serverId, scope?.accountId, catalogEnabled, select]));
  const read = React.useCallback(() => readSelected(undefined), [readSelected]);
  return React.useSyncExternalStore(catalogEnabled ? subscribeSavedSecretCatalogSnapshots : subscribeNoop, read, read);
}

export function useSavedSecretCatalog(
  options?: Readonly<{
    /** Sharing visibility; private owner resources do not depend on Teams. */
    sharedEnabled?: boolean;
    /** Exact Account/Home scope for mounted surfaces that are not on the active Home. */
    scope?: AccountSettingsScope | null;
    /** Legacy caller input; the engine imports Settings material rather than projecting it here. */
    personalSecrets?: readonly SavedSecret[];
    /** Reference-only consumers never request or receive decrypted catalog material. */
    includeMaterial?: boolean;
  }>,
): SavedSecretCatalogProjection {
  const { scope, scopeIsActive, catalogEnabled } =
    useSavedSecretCatalogSource(options);
  const sharedEnabled = Boolean(scope) && options?.sharedEnabled !== false;
  const includeMaterial = options?.includeMaterial !== false;
  const snapshot = React.useSyncExternalStore(
    catalogEnabled ? subscribeSavedSecretCatalogSnapshots : subscribeNoop,
    () => (catalogEnabled ? getSavedSecretCatalogSnapshot(scope) : null),
    () => (catalogEnabled ? getSavedSecretCatalogSnapshot(scope) : null),
  );

  const sharedEntries = snapshot?.data ?? EMPTY_SHARED_ENTRIES;
  const corruptEntries = snapshot?.corruptEntries ?? EMPTY_CORRUPT_ENTRIES;
  const entries = sharedEntries;

  const reload = React.useCallback(async () => {
    if (scope && catalogEnabled)
      await refreshSavedSecretCatalog(scope, { includeMaterial });
  }, [scope, catalogEnabled, includeMaterial]);

  const deleteCorruptResource = React.useCallback(
    async (
      entry: SavedSecretCatalogCorruptOwnerEntry,
    ): Promise<SavedSecretResourceDeleteResult> => {
      if (
        !scope ||
        !scopeIsActive ||
        !catalogEnabled ||
        entry.repair.kind !== 'delete_resource'
      ) {
        return { ok: false, reason: 'unavailable' };
      }
      if (!areServerAccountScopesEqual(getStorage().getState().settingsScope, scope)) {
        return { ok: false, reason: 'unavailable' };
      }
      const result = await deleteSavedSecretResource({
        scope,
        resourceId: entry.repair.resourceId,
        expectedRevision: entry.repair.expectedRevision,
      });
      if (!result.ok && result.reason === 'outcome_unknown') {
        await refreshSavedSecretCatalog(scope).catch(() => undefined);
      }
      return result;
    },
    [scope, scopeIsActive, catalogEnabled],
  );

  const updateResource = React.useCallback(
    async (
      secret: SavedSecret,
      change: Readonly<{ nextName?: string; nextValue?: string }>,
    ): Promise<boolean> => {
      try {
        if (!scope || !scopeIsActive || !catalogEnabled) return false;
        const reference = parseSavedSecretRefV1(secret.id);
        const entry = sharedEntries.find(
          (candidate) => candidate.ref === secret.id,
        );
        if (
          reference.kind !== 'shared_resource' ||
          !entry ||
          entry.relationship !== 'owner' ||
          entry.revision === null ||
          entry.materialStatus !== 'ready' ||
          (change.nextName !== undefined && !entry.capabilities.rename) ||
          (change.nextValue !== undefined && !entry.capabilities.rotate)
        )
          return false;
        const result = await updatePrivateResource(scope, {
          resourceId: reference.resourceId,
          expectedRevision: entry.revision,
          ...change,
        });
        if (
          result.kind === 'failed' &&
          result.failure.kind === 'outcome_unknown'
        )
          await refreshSavedSecretCatalog(scope).catch(() => undefined);
        return result.kind === 'succeeded';
      } catch (error) {
        Modal.alert(
          t('common.error'),
          resolveActionExecutionErrorMessage(error, t('secrets.catalog.operationFailed')),
        );
        return false;
      }
    },
    [scope, scopeIsActive, catalogEnabled, sharedEntries],
  );
  const createPersonal = React.useCallback(
    async (
      input: SavedSecretPersonalCreateInput,
      approval?: SavedSecretPrivateCreationApprovalOptions,
    ) => {
      const name = input.name.trim();
      const kind = input.kind ?? 'apiKey';
      if (!name || ('value' in input ? input.value.length === 0 : false)) return null;
      if (!scope || !scopeIsActive || !catalogEnabled) return null;
      const noteDeclinedApproval = (code: string | null | undefined) => {
        if (isActionApprovalDeclinedErrorCode(code))
          approval?.onApprovalDeclined?.();
      };
      const execute = async (
        callbacks?: Readonly<{
          onApprovalSucceeded: (
            result: Extract<SavedSecretCreationResult, { ok: true }>,
          ) => void;
          onApprovalFailed: (code: string) => void;
        }>,
      ): Promise<SavedSecretCreationResult> => {
        const result = await runTeamAction<SavedSecretCreateActionResult>({
          scope,
          actionId: 'secrets.create',
          input: 'value' in input ? { name, kind, value: input.value,
            ...(input.storeIn ? { storeIn: input.storeIn } : {}) } : { name, kind, source: input.source },
          parse: (value) =>
            PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1[
              'secrets.create'
            ].parse(value),
          ...(approval
            ? {
                signal: approval.signal,
                executorOptions: {
                  // The personal Action retains its plaintext input on the live
                  // invocation. Project that wait through the same mounted UI
                  // observer used by deferred resource approvals.
                  onBlockingApprovalPending: ({ artifactId }) =>
                    approval.onApprovalPending(artifactId),
                },
              }
            : {}),
          ...(callbacks
            ? {
                onApprovalSucceeded: (value) =>
                  callbacks.onApprovalSucceeded({
                    ok: true,
                    resourceRef: value.secretRef,
                    revision: 1,
                  }),
                onApprovalFailed: callbacks.onApprovalFailed,
              }
            : {}),
        });
        // A blocking approval settles on this live invocation: a decline arrives here as its failure code.
        if (result.kind === 'failed') noteDeclinedApproval(result.failure.code);
        return result.kind === 'succeeded'
          ? { ok: true, resourceRef: result.value.secretRef, revision: 1 }
          : projectSavedSecretResourceOperationFailure(result.failure);
      };
      const result = approval
        ? await awaitActionApprovalResult<
            Extract<Awaited<ReturnType<typeof execute>>, { ok: true }>,
            Awaited<ReturnType<typeof execute>>
          >({
            ...(approval.signal ? { signal: approval.signal } : {}),
            execute: async (callbacks) => {
              try {
                return await execute(callbacks);
              } catch (error) {
                if (!isTeamActionApprovalPendingError(error)) throw error;
                approval.onApprovalPending(error.registration);
                return { approvalPending: true };
              }
            },
            succeeded: (value) => value,
            failed: (code) => {
              noteDeclinedApproval(code);
              return projectSavedSecretResourceOperationFailure(homeDomainFailureFromActionFailure({ errorCode: code }));
            },
            aborted: () => ({ ok: false, reason: 'changed' }),
          })
        : await execute();
      if (!result.ok && result.reason === 'outcome_unknown')
        await refreshSavedSecretCatalog(scope, { includeMaterial }).catch(
          () => undefined,
        );
      if (!result.ok && result.failure && !isActionApprovalDeclinedErrorCode(result.failure.code)) {
        throw new HappyError('Saved Secret creation refused', false, { code: result.failure.code });
      }
      return result.ok ? result.resourceRef : null;
    },
    [scope, scopeIsActive, catalogEnabled, includeMaterial],
  );
  const renamePersonal = React.useCallback(
    async (secret: SavedSecret, directName?: string) => {
      const name =
        directName ??
        (await Modal.prompt(
          t('secrets.prompts.renameTitle'),
          t('secrets.prompts.renameDescription'),
          {
            defaultValue: secret.name,
            placeholder: t('secrets.fields.name'),
            cancelText: t('common.cancel'),
            confirmText: t('common.rename'),
          },
        ));
      if (name === null) return false;
      const normalizedName = name.trim();
      if (!normalizedName) return false;
      return updateResource(secret, { nextName: normalizedName });
    },
    [updateResource],
  );
  const rotatePersonal = React.useCallback(
    async (secret: SavedSecret, directValue?: string) => {
      const value =
        directValue ??
        (await Modal.prompt(
          t('secrets.prompts.replaceValueTitle'),
          t('secrets.prompts.replaceValueDescription'),
          {
            placeholder: 'sk-...',
            inputType: 'secure-text',
            cancelText: t('common.cancel'),
            confirmText: t('secrets.actions.replace'),
          },
        ));
      if (value === null) return false;
      if (value.length === 0) return false;
      return updateResource(secret, { nextValue: value });
    },
    [updateResource],
  );
  const deletePersonal = React.useCallback(
    async (secret: SavedSecret) => {
      if (!scope || !scopeIsActive || !catalogEnabled) return false;
      if (!areServerAccountScopesEqual(getStorage().getState().settingsScope, scope))
        return false;
      const reference = parseSavedSecretRefV1(secret.id);
      const entry = sharedEntries.find(
        (candidate) => candidate.ref === secret.id,
      );
      if (
        reference.kind !== 'shared_resource' ||
        !entry ||
        entry.relationship !== 'owner' ||
        entry.revision === null ||
        !entry.capabilities.delete
      )
        return false;
      const result = await runTeamAction({
        scope,
        actionId: 'secrets.delete',
        input: {
          secretId: reference.resourceId,
          expectedUpdatedAt: entry.revision,
        },
        parse: (value) =>
          PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1[
            'secrets.delete'
          ].parse(value),
      });
      if (result.kind === 'failed' && result.failure.kind === 'outcome_unknown')
        await refreshSavedSecretCatalog(scope).catch(() => undefined);
      return result.kind === 'succeeded';
    },
    [scope, scopeIsActive, catalogEnabled, sharedEntries],
  );
  const linkVaultItems = React.useCallback(async (input: VaultInput<'secrets.link'>, signal?: AbortSignal) => {
    if (!scope || !scopeIsActive || !catalogEnabled) return { kind: 'failed' as const,
      failure: { kind: 'unreachable' as const, code: 'unavailable', retryable: true } };
    return runTeamAction({ scope, actionId: 'secrets.link', input, signal,
      parse: value => PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1['secrets.link'].parse(value) });
  }, [scope, scopeIsActive, catalogEnabled]);
  const exportResourcesToVault = React.useCallback(async (input: VaultInput<'secrets.export'>, signal?: AbortSignal) => {
    if (!scope || !scopeIsActive || !catalogEnabled) return { kind: 'failed' as const,
      failure: { kind: 'unreachable' as const, code: 'unavailable', retryable: true } };
    return runTeamAction({ scope, actionId: 'secrets.export', input, signal,
      parse: value => PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1['secrets.export'].parse(value) });
  }, [scope, scopeIsActive, catalogEnabled]);
  const personalMutations = React.useMemo(
    () =>
      Object.freeze({
        create: createPersonal,
        rename: renamePersonal,
        rotate: rotatePersonal,
        delete: deletePersonal,
      }),
    [createPersonal, deletePersonal, renamePersonal, rotatePersonal],
  );
  const usableSecrets = React.useMemo(
    () =>
      catalogEnabled && includeMaterial
        ? getUsableSavedSecrets(scope, EMPTY_MATERIALIZED_SECRETS)
        : EMPTY_MATERIALIZED_SECRETS,
    [scope, catalogEnabled, includeMaterial, snapshot],
  );
  const personalSecrets = React.useMemo(
    () => scopeIsActive ? projectPersonalSavedSecrets(entries, usableSecrets) : EMPTY_MATERIALIZED_SECRETS,
    [entries, scopeIsActive, usableSecrets],
  );
  const displayedSharedEntries = React.useMemo(() => {
    if (personalSecrets.length === 0) return sharedEntries;
    const privateRefs = new Set(personalSecrets.map((secret) => secret.id));
    return sharedEntries.filter((entry) => !privateRefs.has(entry.ref));
  }, [personalSecrets, sharedEntries]);
  const picker = React.useMemo(
    () =>
      Object.freeze({ personalSecrets, sharedEntries: displayedSharedEntries }),
    [personalSecrets, displayedSharedEntries],
  );
  const updateCatalogResource = React.useCallback(
    async (
      input: Omit<Parameters<typeof updateSavedSecretResource>[0], 'scope'>,
    ) => {
      if (!scope || !scopeIsActive)
        return { ok: false as const, reason: 'unavailable' as const };
      const secret = personalSecrets.find((secret) => {
        const reference = parseSavedSecretRefV1(secret.id);
        return (
          reference.kind === 'shared_resource' &&
          reference.resourceId === input.resourceId
        );
      });
      // Privacy is decided once by this catalog projection. Storage conversion
      // retains the resource Action, with its separate disclosure and review.
      if (!secret || input.toMode !== undefined)
        return updateSavedSecretResource({ ...input, scope });
      const result = await updatePrivateResource(scope, input);
      return result.kind === 'succeeded'
        ? { ok: true as const }
        : projectSavedSecretResourceUpdateFailure(result.failure);
    },
    [personalSecrets, scope, scopeIsActive],
  );
  const resolveReference = React.useCallback(
    (ref: string) => {
      return resolveSavedSecretReference(
        scope,
        EMPTY_MATERIALIZED_SECRETS,
        ref,
        { includeMaterial },
      );
    },
    [scope, snapshot, includeMaterial],
  );

  return Object.freeze({
    sharedEnabled,
    personalSecrets,
    personalMutationsAvailable: scopeIsActive && catalogEnabled,
    personalMutations,
    collisionMigrationStatus: 'not_required',
    entries,
    sharedEntries: displayedSharedEntries,
    picker,
    updateResource: updateCatalogResource,
    linkVaultItems,
    exportResourcesToVault,
    corruptEntries,
    deleteCorruptResource,
    materializedSecrets: includeMaterial
      ? getMaterializedSavedSecrets(scope)
      : EMPTY_MATERIALIZED_SECRETS,
    usableSecrets,
    resolveReference,
    status: catalogEnabled ? (snapshot?.status ?? 'loading') : 'ready',
    stale: catalogEnabled ? (snapshot?.stale ?? true) : false,
    error:
      catalogEnabled &&
      snapshot?.error !== null &&
      snapshot?.error !== undefined,
    errorCause: catalogEnabled ? snapshot?.error ?? null : null,
    reload,
  });
}

const EMPTY_SHARED_ENTRIES: readonly SavedSecretCatalogEntryV1[] =
  Object.freeze([]);
const EMPTY_CORRUPT_ENTRIES: readonly SavedSecretCatalogCorruptEntryV1[] =
  Object.freeze([]);
const EMPTY_MATERIALIZED_SECRETS: readonly SavedSecret[] = Object.freeze([]);
const subscribeNoop = () => () => undefined;

function updatePrivateResource(
  scope: AccountSettingsScope,
  input: Pick<
    Parameters<typeof updateSavedSecretResource>[0],
    'resourceId' | 'expectedRevision' | 'nextName' | 'nextValue' | 'nextSource'
  > & Partial<Pick<Parameters<typeof updateSavedSecretResource>[0], 'onApprovalSucceeded' | 'onApprovalFailed'>>,
) {
  return runTeamAction<ReturnType<(typeof PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1)['secrets.update']['parse']>>({
    scope,
    actionId: 'secrets.update',
    input: {
      secretId: input.resourceId,
      expectedUpdatedAt: input.expectedRevision,
      ...(input.nextName === undefined ? {} : { name: input.nextName }),
      ...(input.nextValue === undefined ? {} : { value: input.nextValue }),
      ...(input.nextSource === undefined ? {} : { source: input.nextSource }),
    },
    parse: (value) =>
      PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1['secrets.update'].parse(
        value,
      ),
    ...(input.onApprovalSucceeded ? { onApprovalSucceeded: async value => {
      await input.onApprovalSucceeded?.({ resourceId: input.resourceId, revision: value.updatedAt });
    } } : {}),
    ...(input.onApprovalFailed ? { onApprovalFailed: (code, failure) => {
      input.onApprovalFailed?.(code, projectSavedSecretResourceUpdateFailure(
        homeDomainFailureFromActionFailure(failure ?? { errorCode: code })));
    } } : {}),
  });
}
