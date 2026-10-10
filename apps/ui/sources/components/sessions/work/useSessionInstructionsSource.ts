import * as React from 'react';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { SessionPromptStackV1Schema } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import type { PromptDocArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';
import { readPromptDocInLibrary } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { withUiPromptLibraryArtifactReader } from '@/sync/ops/promptLibrary/promptLibraryArtifactStore';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import {
  useServerCredentialAccountScopeBindings,
  type ServerCredentialAccountScopeBinding,
} from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { ActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import {
  applyActionSettingsTargetControlState,
  resolveActionSettingsTargetControlState,
  type ActionSettingsApprovalControlValue,
  type ActionSettingsTargetControlState,
} from '@/components/settings/actions/actionSettingsTargets';

export type SessionInstructionsAccess =
  | 'readable'
  | 'owner_private'
  | 'locked'
  | 'unavailable';
type InstructionsDocument = Extract<
  Awaited<ReturnType<typeof readPromptDocInLibrary>>,
  { ok: true }
>;
type InstructionsStatus =
  | 'inactive'
  | 'none'
  | 'loading'
  | 'refreshing'
  | 'ready'
  | 'not_found'
  | 'wrong_kind'
  | 'malformed'
  | 'locked'
  | 'owner_private'
  | 'unavailable';
type DisplayState = Readonly<{
  status: InstructionsStatus;
  document: InstructionsDocument | null;
  stale: boolean;
}>;
export type SessionInstructionsSource = DisplayState &
  Readonly<{
    ref: PromptDocArtifactRefV1 | null;
    retry: () => Promise<void>;
  }>;

const StoredStackSchema = createStoredReadSchema(SessionPromptStackV1Schema);
const NO_DOCUMENT: DisplayState = {
  status: 'none',
  document: null,
  stale: false,
};
const INACTIVE: DisplayState = {
  status: 'inactive',
  document: null,
  stale: false,
};
const NO_RETRY = async () => {};
const NO_SELECTION = { ref: null, status: 'none' } as const;

function selectInstructions(metadata: unknown): Readonly<{
  ref: PromptDocArtifactRefV1 | null;
  status: 'none' | 'malformed' | 'wrong_kind';
}> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    return { ref: null, status: 'none' };
  const work: unknown = Reflect.get(metadata, 'work');
  if (work === undefined) return { ref: null, status: 'none' };
  if (!work || typeof work !== 'object' || Array.isArray(work))
    return { ref: null, status: 'malformed' };
  const parsed = StoredStackSchema.safeParse(
    Reflect.get(work, 'promptStack') ?? [],
  );
  if (!parsed.success) return { ref: null, status: 'malformed' };
  const entry = parsed.data.find(
    (candidate) => candidate.id === 'session.instructions',
  );
  if (!entry) return { ref: null, status: 'none' };
  if (entry.ref.kind !== 'doc') return { ref: null, status: 'wrong_kind' };
  return { ref: { ...entry.ref, kind: 'doc' }, status: 'none' };
}

/** Display-only consumer of the canonical qualified read; preparation never consumes this state. */
export function useSessionInstructionsSource(
  params: Readonly<{
    sessionId: string;
    serverId: string | null;
    operationBinding: ServerCredentialAccountScopeBinding | null;
    ownerMetadata: unknown;
    enabled: boolean;
    access: SessionInstructionsAccess;
  }>,
): SessionInstructionsSource {
  const selected = React.useMemo(
    () =>
      params.enabled ? selectInstructions(params.ownerMetadata) : NO_SELECTION,
    [params.enabled, params.ownerMetadata],
  );
  const ref = selected.ref;
  const sessionHome = params.serverId
    ? resolveServerProfileScopeIdForIdentifier(params.serverId)
    : null;
  const documentHome = ref
    ? resolveServerProfileScopeIdForIdentifier(ref.serverId ?? params.serverId)
    : null;
  const demanded =
    params.enabled &&
    params.access === 'readable' &&
    sessionHome !== null &&
    ref !== null;
  // Reuse the header's existing Session Home lifetime. Only open detail demands a foreign Home.
  const foreignHomes = React.useMemo(
    () =>
      demanded && documentHome && documentHome !== sessionHome
        ? [documentHome]
        : [],
    [demanded, documentHome, sessionHome],
  );
  const foreignBindings = useServerCredentialAccountScopeBindings(foreignHomes);
  const operationBinding = params.operationBinding;
  const documentBinding =
    documentHome === sessionHome
      ? operationBinding
      : documentHome
        ? foreignBindings.get(documentHome)
        : null;
  const readable =
    demanded &&
    operationBinding?.isCurrent() === true &&
    documentBinding?.isCurrent() === true;
  const key = JSON.stringify([
    sessionHome,
    operationBinding?.accountId,
    operationBinding?.revision,
    params.sessionId,
    documentHome,
    documentBinding?.accountId,
    documentBinding?.revision,
    ref?.artifactId,
  ]);
  const [loaded, setLoaded] = React.useState<Readonly<{
    key: string;
    display: DisplayState;
  }> | null>(null);
  const pending = React.useRef<Readonly<{
    key: string;
    controller: AbortController;
    promise: Promise<void>;
  }> | null>(null);
  const refresh = React.useCallback((): Promise<void> => {
    if (!readable || !ref || !documentHome) return Promise.resolve();
    if (pending.current?.key === key) return pending.current.promise;
    pending.current?.controller.abort();
    const controller = new AbortController();
    setLoaded((previous) => {
      const document = previous?.key === key ? previous.display.document : null;
      return {
        key,
        display: {
          status: document ? 'refreshing' : 'loading',
          document,
          stale: document !== null,
        },
      };
    });
    const promise = (async () => {
      try {
        const result = await withUiPromptLibraryArtifactReader(
          (reader) =>
            readPromptDocInLibrary({
              artifactId: ref.artifactId,
              store: { read: () => reader.readArtifact(ref) },
              signal: controller.signal,
            }),
          { serverId: params.serverId, signal: controller.signal },
        );
        if (
          controller.signal.aborted ||
          !operationBinding?.isCurrent() ||
          !documentBinding?.isCurrent()
        )
          return;
        const display: DisplayState = result.ok
          ? { status: 'ready', document: result, stale: false }
          : {
              status:
                result.errorCode === 'prompt_doc_not_found'
                  ? 'not_found'
                  : result.errorCode === 'prompt_doc_wrong_kind'
                    ? 'wrong_kind'
                    : 'malformed',
              document: null,
              stale: false,
            };
        setLoaded({ key, display });
      } catch (error) {
        if (
          controller.signal.aborted ||
          !operationBinding?.isCurrent() ||
          !documentBinding?.isCurrent()
        )
          return;
        const code: unknown =
          error && typeof error === 'object'
            ? Reflect.get(error, 'code')
            : undefined;
        const locked =
          code === 'content_unavailable' ||
          code === 'artifact_content_unavailable' ||
          code === 'artifact_encryption_material_unavailable' ||
          code === 'artifact_account_mode_mismatch' ||
          code === 'account_encryption_mode_unavailable';
        setLoaded((previous) => {
          const document =
            !locked &&
            code !== 'action_account_scope_changed' &&
            previous?.key === key
              ? previous.display.document
              : null;
          return {
            key,
            display: {
              status: locked ? 'locked' : 'unavailable',
              document,
              stale: document !== null,
            },
          };
        });
      } finally {
        if (pending.current?.controller === controller) pending.current = null;
      }
    })();
    pending.current = { key, controller, promise };
    return promise;
  }, [
    documentBinding,
    documentHome,
    key,
    operationBinding,
    readable,
    ref?.artifactId,
    ref?.serverId,
    params.serverId,
  ]);
  React.useEffect(() => {
    const clear = () => {
      pending.current?.controller.abort();
      pending.current = null;
      // Retirement is a settled withdrawal, not an outstanding body read.
      setLoaded({
        key,
        display: { status: 'unavailable', document: null, stale: false },
      });
    };
    if (!readable) {
      clear();
      return;
    }
    const retirements = [...new Set([operationBinding, documentBinding])]
      .filter((binding): binding is ServerCredentialAccountScopeBinding =>
        Boolean(binding),
      )
      .map((binding) => binding.onRetire(clear));
    return () => {
      for (const retirement of retirements) retirement.dispose();
    };
  }, [documentBinding, key, operationBinding, readable]);
  React.useEffect(() => {
    if (readable) void refresh();
    return () => {
      pending.current?.controller.abort();
      pending.current = null;
    };
  }, [readable, refresh]);
  let display: DisplayState;
  if (!params.enabled) display = INACTIVE;
  else if (params.access !== 'readable')
    display = { status: params.access, document: null, stale: false };
  else if (!params.serverId)
    display = { status: 'unavailable', document: null, stale: false };
  else if (!ref)
    display =
      selected.status === 'none'
        ? NO_DOCUMENT
        : { status: selected.status, document: null, stale: false };
  else if (!readable)
    display = { status: 'unavailable', document: null, stale: false };
  else
    display =
      loaded?.key === key
        ? loaded.display
        : { status: 'loading', document: null, stale: false };
  return React.useMemo(
    () => ({
      ...display,
      ref: params.enabled && params.access === 'readable' ? ref : null,
      retry: readable ? refresh : NO_RETRY,
    }),
    [display, params.access, params.enabled, readable, ref, refresh],
  );
}

/**
 * The open Work detail's demand for its Session's current Instructions. Only the Instructions section
 * mounts it, so the permanent header, the roster and a closed Work pane never read document content.
 * It binds the Session Home's Account lifetime exactly as the Work owner does.
 */
export function useSessionInstructionsDetail(
  params: Readonly<{
    sessionId: string;
    serverId: string | null;
    ownerMetadata: unknown;
    access: SessionInstructionsAccess;
  }>,
): SessionInstructionsSource {
  const operationServerId = params.serverId
    ? resolveServerProfileScopeIdForIdentifier(params.serverId)
    : null;
  const homes = React.useMemo(
    () => (operationServerId ? [operationServerId] : []),
    [operationServerId],
  );
  const bindings = useServerCredentialAccountScopeBindings(homes);
  return useSessionInstructionsSource({
    sessionId: params.sessionId,
    serverId: params.serverId,
    operationBinding: operationServerId
      ? (bindings.get(operationServerId) ?? null)
      : null,
    ownerMetadata: params.ownerMetadata,
    enabled: true,
    access: params.access,
  });
}

export type SessionInstructionsPolicyTarget = 'agent' | 'mcp' | 'cli' | 'voice';
export type SessionInstructionsPolicy = Readonly<{
  actionId: 'prompt_doc.update';
  targetId: SessionInstructionsPolicyTarget;
  scope: 'account_action_surface';
  controlState: ActionSettingsTargetControlState;
  setValue: (value: ActionSettingsApprovalControlValue) => void;
}>;

/**
 * Work's Agent edits row: the existing Account Actions setting for `prompt_doc.update` on one Action
 * surface, honestly scoped to every Session on that surface — never a per-Session or per-Bot waiver.
 */
export function resolveSessionInstructionsPolicy(
  params: Readonly<{
    settings: ActionsSettingsV1;
    targetId: SessionInstructionsPolicyTarget;
    onChange: (settings: ActionsSettingsV1) => void;
  }>,
): SessionInstructionsPolicy {
  return {
    actionId: 'prompt_doc.update',
    targetId: params.targetId,
    scope: 'account_action_surface',
    controlState: resolveActionSettingsTargetControlState({
      settings: params.settings,
      actionId: 'prompt_doc.update',
      targetId: params.targetId,
    }),
    setValue: (value) =>
      params.onChange(
        applyActionSettingsTargetControlState({
          settings: params.settings,
          actionId: 'prompt_doc.update',
          targetId: params.targetId,
          value,
        }),
      ),
  };
}
