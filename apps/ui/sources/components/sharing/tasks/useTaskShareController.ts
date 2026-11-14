import * as React from 'react';
import {
  InternalTaskAccessOutputSchema,
  InternalTaskMutationOutputSchema,
  InternalTaskPrepareOutputSchema,
  InternalTaskReadOutputSchema,
  type TaskAccessGrantRowV1,
} from '@happier-dev/protocol/actions/internalTaskActions';
import type {
  ResourceCallerAccessV1,
} from '@happier-dev/protocol/teams/resourceGrantAccessV1';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';

import { sessionAccessSubjectKey } from '@/components/sessions/access/projectSessionAccessEditorSnapshot';
import { useSessionAccessDirectory } from '@/components/sessions/access/useSessionAccessDirectory';
import { useResourceGrantGroupDisplayNames } from '@/hooks/teams/useTeamGroupDisplayNames';
import { useAccountEncryptionMode } from '@/components/settings/account/useAccountEncryptionMode';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { t } from '@/text';
import { presentSharePrincipal } from '../sharePrincipalPresentation';
import { useShareViewerProfile } from '../useShareViewerProfile';
import type {
  ShareAccessLevel,
  ShareGrantRowModel,
  ShareOperationModel,
  ShareSheetActions,
  ShareSheetModel,
  ShareUiError,
  ShareUiReason,
} from '../shareSheetTypes';
import {
  readTaskShareDisclosure,
  type TaskShareDisclosure,
  type TaskShareRecipientState,
} from './taskShareAdapter';

type Mutation =
  | Readonly<{
      kind: 'set';
      principal: PrincipalRefV1;
      accessLevel: ShareAccessLevel;
    }>
  | Readonly<{ kind: 'remove'; principal: PrincipalRefV1 }>;
type Roster = Readonly<{
  ownerAccountId: string;
  access: ResourceCallerAccessV1 | null;
  grants: readonly TaskAccessGrantRowV1[];
}>;
type State = Readonly<{
  phase: 'initial' | 'ready' | 'error';
  roster: Roster | null;
  issue?: ShareUiError;
  operations: Readonly<Record<string, ShareOperationModel>>;
  confirmingRemoval: string | null;
}>;

const IDLE: ShareOperationModel = { kind: 'idle' };
const NO_TEAM_CONTEXTS: readonly [] = [];
const NO_GRANTS: readonly TaskAccessGrantRowV1[] = [];

/** One message per task grant failure; the codes stay the task resource owner's. */
export function presentTaskShareFailure(code: string): ShareUiError {
  switch (code) {
    case 'task_resource_unsupported':
      return {
        code,
        message: t('shareSheet.tasks.errors.updateRequired'),
        retryable: false,
      };
    case 'unavailable':
    case 'unsupported_action':
    case 'not_authenticated':
      return {
        code,
        message: t('shareSheet.tasks.errors.unavailable'),
        retryable: false,
      };
    case 'task_access_forbidden':
      return {
        code,
        message: t('shareSheet.tasks.errors.ownerOnly'),
        retryable: false,
      };
    case 'task_not_found':
      return {
        code,
        message: t('shareSheet.tasks.errors.notFound'),
        retryable: false,
      };
    case 'task_access_revoked':
      return {
        code,
        message: t('shareSheet.tasks.errors.noAccess'),
        retryable: false,
      };
    case 'task_subject_not_found':
    case 'task_subject_ineligible':
    case 'task_owner_grant_invalid':
      return {
        code,
        message: t('shareSheet.tasks.errors.subjectUnavailable'),
        retryable: false,
      };
    default:
      return {
        code,
        message: t('shareSheet.tasks.errors.failed'),
        retryable: true,
      };
  }
}

function failureCode(
  result: unknown,
  parsed?: Readonly<{ status: string; reason?: string }> | null,
): string {
  if (parsed) return parsed.reason ?? parsed.status;
  const record =
    result && typeof result === 'object'
      ? (result as Record<string, unknown>)
      : {};
  return typeof record.errorCode === 'string'
    ? record.errorCode
    : 'task_access_failed';
}

/**
 * The task adapter's controller: one owner-qualified task's grants, read and written only through
 * the `tasks.internal.*` Actions. Every acknowledged roster replaces the last one, so the sheet never
 * shows a guess; the disclosure comes from the same admitted task read the recipients will get.
 */
export function useTaskShareController(
  input: Readonly<{
    taskId: string;
    ownerAccountId: string;
    scope: ServerAccountScope;
  }>,
): Readonly<{
  model: ShareSheetModel;
  actions: ShareSheetActions;
  disclosure: TaskShareDisclosure | null;
  encrypted: boolean;
  readiness: ReadonlyMap<string, TaskShareRecipientState>;
  sendKeys?: () => void;
  sendingKeys: boolean;
  issue?: ShareUiError;
  notice?: ShareUiReason;
  loading: boolean;
  retryContent(): void;
}> {
  const { taskId, ownerAccountId, scope } = input;
  const viewerProfile = useShareViewerProfile(scope);
  const encryptionMode = useAccountEncryptionMode();
  const identity = `${scope.serverId}:${scope.accountId}:${ownerAccountId}:${taskId}`;
  const [execute] = React.useState(() => createFrontDoorActionExecute());
  const [state, setState] = React.useState<State>({
    phase: 'initial',
    roster: null,
    operations: {},
    confirmingRemoval: null,
  });
  const [disclosure, setDisclosure] =
    React.useState<TaskShareDisclosure | null>(null);
  const [query, setQuery] = React.useState('');
  const [notice, setNotice] = React.useState<ShareUiReason | undefined>();
  const [revision, setRevision] = React.useState(0);
  const [sendingKeys, setSendingKeys] = React.useState(false);
  const lastMutation = React.useRef(new Map<string, Mutation>());
  const current = React.useRef<string | null>(identity);
  current.current = identity;
  React.useEffect(() => {
    current.current = identity;
    return () => {
      if (current.current === identity) current.current = null;
    };
  }, [identity]);
  const context = React.useMemo(
    () => ({
      surface: 'ui' as const,
      serverId: scope.serverId,
      expectedAccountId: scope.accountId,
    }),
    [scope.serverId, scope.accountId],
  );
  const address = React.useMemo(
    () => ({ taskId, ownerAccountId }),
    [taskId, ownerAccountId],
  );
  const actionScope = React.useMemo(
    () => ({ serverId: scope.serverId, accountId: scope.accountId }),
    [scope.serverId, scope.accountId],
  );

  const applyAccess = React.useCallback((result: unknown, key?: string) => {
    const parsed = (result as { ok?: boolean })?.ok
      ? InternalTaskAccessOutputSchema.safeParse(
          (result as { result: unknown }).result,
        )
      : null;
    setState((previous) => {
      const operations = key
        ? (({ [key]: _settled, ...rest }) => rest)(previous.operations)
        : previous.operations;
      if (parsed?.success && parsed.data.status === 'access') {
        if (parsed.data.access === null) {
          lastMutation.current.clear();
          return {
            phase: 'ready',
            roster: null,
            operations: {},
            confirmingRemoval: null,
            issue: presentTaskShareFailure('task_access_revoked'),
          };
        }
        if (key) lastMutation.current.delete(key);
        return {
          ...previous,
          phase: 'ready',
          operations,
          issue: undefined,
          roster: {
            ownerAccountId: parsed.data.ownerAccountId,
            access: parsed.data.access,
            grants: parsed.data.grants,
          },
        };
      }
      const error = presentTaskShareFailure(
        failureCode(
          result,
          parsed?.success
            ? (parsed.data as { status: string; reason?: string })
            : null,
        ),
      );
      return key
        ? {
            ...previous,
            operations: { ...operations, [key]: { kind: 'error', error } },
          }
        : { ...previous, phase: 'error', issue: error };
    });
  }, []);

  const load = React.useCallback(async () => {
    const [grants, read] = await Promise.all([
      execute('tasks.internal.grants', address, context).catch(() => null),
      execute('tasks.internal.read', address, context).catch(() => null),
    ]);
    if (current.current !== identity) return;
    applyAccess(grants);
    const task = read?.ok
      ? InternalTaskReadOutputSchema.safeParse(read.result)
      : null;
    if (task?.success && task.data.status === 'applied')
      setDisclosure(readTaskShareDisclosure(task.data.todo));
  }, [address, applyAccess, context, execute, identity]);
  React.useEffect(() => {
    void load();
  }, [load]);

  const mutate = React.useCallback(
    async (mutation: Mutation) => {
      const key = sessionAccessSubjectKey(mutation.principal);
      lastMutation.current.set(key, mutation);
      setState((previous) => ({
        ...previous,
        confirmingRemoval: null,
        operations: {
          ...previous.operations,
          [key]: { kind: mutation.kind === 'remove' ? 'removing' : 'saving' },
        },
      }));
      if (mutation.kind === 'remove') {
        const result = await execute(
          'tasks.internal.unshare',
          { scope: actionScope, ...address, principal: mutation.principal },
          context,
        ).catch(() => null);
        if (current.current !== identity) return;
        applyAccess(result, key);
      } else {
        const result = await execute(
          'tasks.internal.share',
          {
            scope: actionScope,
            ...address,
            principal: mutation.principal,
            accessLevel: mutation.accessLevel,
          },
          context,
        ).catch(() => null);
        if (current.current !== identity) return;
        const parsed = result?.ok
          ? InternalTaskMutationOutputSchema.safeParse(result.result)
          : null;
        if (parsed?.success && parsed.data.status === 'applied') {
          setDisclosure(readTaskShareDisclosure(parsed.data.todo));
          // The roster owner answers who has access now; the share reply carries only the task.
          applyAccess(
            await execute('tasks.internal.grants', address, context).catch(
              () => null,
            ),
            key,
          );
        } else {
          const error = presentTaskShareFailure(
            failureCode(
              result,
              parsed?.success
                ? (parsed.data as { status: string; reason?: string })
                : null,
            ),
          );
          setState((previous) => ({
            ...previous,
            operations: {
              ...previous.operations,
              [key]: { kind: 'error', error },
            },
          }));
        }
      }
      setRevision((value) => value + 1);
    },
    [actionScope, address, applyAccess, context, execute, identity],
  );

  const roster = state.roster;
  const isOwner = roster?.access === 'owner';
  const editable = isOwner || roster?.access === 'admin';
  const grants = roster?.grants ?? NO_GRANTS;
  const groupDisplayNames = useResourceGrantGroupDisplayNames({ scope, grants });
  const readiness = React.useMemo<ReadonlyMap<string, TaskShareRecipientState>>(
    () => new Map(grants.flatMap(row => row.readiness === undefined ? []
      : [[sessionAccessSubjectKey(row.principal), row.readiness] as const])),
    [grants],
  );
  const rows = React.useMemo<readonly ShareGrantRowModel[]>(
    () =>
      grants.map((row) => {
        const principal = presentSharePrincipal({
          ref: row.principal,
          name: row.principal.kind === 'group' ? groupDisplayNames.get(row.principal.groupId) ?? null : row.display.name,
          username: row.display.username,
          viewerAccountId: scope.accountId,
          profile:
            row.principal.kind === 'account' &&
            row.principal.accountId === scope.accountId
              ? viewerProfile
              : null,
        });
        return {
          grant: row.principal,
          principal,
          level: {
            kind: 'editable',
            value: row.accessLevel === 'admin' ? 'edit' : row.accessLevel,
            options: ['view', 'edit'],
          },
          removal:
            state.confirmingRemoval === principal.key
              ? {
                  kind: 'confirming',
                  consequences: [
                    row.principal.kind === 'account'
                      ? t('shareSheet.removeLosesPerson', {
                          name: principal.displayName,
                        })
                      : t('shareSheet.removeLosesMembers', {
                          name: principal.displayName,
                        }),
                  ],
                }
              : { kind: 'allowed' },
          operation: state.operations[principal.key] ?? IDLE,
        };
      }),
    [
      grants,
      groupDisplayNames,
      state.operations,
      state.confirmingRemoval,
      scope.accountId,
      viewerProfile,
    ],
  );
  const owner =
    roster && roster.ownerAccountId === scope.accountId
      ? {
          principal: presentSharePrincipal({
            ref: { kind: 'account', accountId: roster.ownerAccountId },
            profile: viewerProfile,
            viewerAccountId: scope.accountId,
          }),
        }
      : null;
  const directory = useSessionAccessDirectory({
    scope,
    availability: 'available',
    contextTeams: NO_TEAM_CONTEXTS,
    operations: state.operations,
    revision,
    enabled: editable,
  });

  const sendKeys = React.useCallback(async () => {
    setSendingKeys(true);
    const result = await execute(
      'tasks.internal.prepare',
      { scope: actionScope, ...address },
      context,
    ).catch(() => null);
    if (current.current !== identity) return;
    setSendingKeys(false);
    const parsed = result?.ok
      ? InternalTaskPrepareOutputSchema.safeParse(result.result)
      : null;
    if (!(parsed?.success && parsed.data.status === 'prepared'))
      setNotice(presentTaskShareFailure(failureCode(result)));
  }, [actionScope, address, context, execute, identity]);

  const actions = React.useMemo<ShareSheetActions>(
    () => ({
      setQuery,
      retryDirectory: directory.retry,
      loadMore: directory.loadMore,
      addPrincipal: (principal) => {
        void mutate({ kind: 'set', principal, accessLevel: 'view' });
      },
      retryMutation: (grant) => {
        const mutation = lastMutation.current.get(
          sessionAccessSubjectKey(grant),
        );
        if (mutation) void mutate(mutation);
      },
      setAccessLevel: (grant, accessLevel) => {
        void mutate({ kind: 'set', principal: grant, accessLevel });
      },
      requestRemove: (grant) => {
        const key = sessionAccessSubjectKey(grant);
        if (
          editable &&
          grants.some((row) => sessionAccessSubjectKey(row.principal) === key)
        ) {
          setState((previous) => ({ ...previous, confirmingRemoval: key }));
        }
      },
      confirmRemove: (grant) => {
        if (
          editable &&
          state.confirmingRemoval === sessionAccessSubjectKey(grant)
        )
          void mutate({ kind: 'remove', principal: grant });
      },
      cancelRemove: (grant) => {
        setState((previous) =>
          previous.confirmingRemoval === sessionAccessSubjectKey(grant)
            ? { ...previous, confirmingRemoval: null }
            : previous,
        );
      },
      explain: setNotice,
    }),
    [
      directory.loadMore,
      directory.retry,
      editable,
      grants,
      mutate,
      state.confirmingRemoval,
    ],
  );

  return {
    model: {
      revision,
      editable,
      stale: state.phase === 'error' && roster !== null,
      owner,
      grants: rows,
      directory: { query, sections: editable ? directory.sections : [] },
    },
    actions,
    disclosure,
    encrypted: isOwner ? encryptionMode === 'e2ee' : false,
    readiness,
    ...(editable && encryptionMode === 'e2ee' && grants.length > 0
      ? {
          sendKeys: () => {
            void sendKeys();
          },
        }
      : {}),
    sendingKeys,
    ...(state.issue ? { issue: state.issue } : {}),
    ...(notice ? { notice } : {}),
    loading: state.phase === 'initial',
    retryContent: () => {
      void load();
    },
  };
}
