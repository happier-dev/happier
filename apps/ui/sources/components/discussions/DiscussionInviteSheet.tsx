import { SHARE_SHEET_HOST } from '@/components/sharing/shareSheetHost';
import type { DiscussionParticipantRoster } from './useDiscussionParticipantManagement';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import type { ExecutableParticipantSelectionV1 } from '@happier-dev/protocol/discussions/executableParticipants';
import type { SessionMessageAccountActorV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageAccountActorV1';
import { classifyAccountActorLabelV1 } from '@happier-dev/protocol/account/accountDisplayProfileV1';

import { sessionAccessSubjectKey } from '@/components/sessions/access/projectSessionAccessEditorSnapshot';
import { useSessionAccessDirectory } from '@/components/sessions/access/useSessionAccessDirectory';
import { ShareSheet } from '@happier-dev/plugin-ui/components';
import { presentSharePrincipal } from '@/components/sharing/sharePrincipalPresentation';
import { useShareViewerProfile } from '@/components/sharing/useShareViewerProfile';
import type {
  ShareAccessLevel,
  ShareGrantRowModel,
  ShareOperationModel,
  ShareSheetActions,
  ShareSheetAdapter,
  ShareSheetModel,
  ShareUiError,
  ShareUiReason,
} from '@/components/sharing/shareSheetTypes';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { useSurfaceStateSize } from '@/components/ui/surfaces/surfaceStateSize';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import {
  MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS,
  Popover,
} from '@/components/ui/popover';
import { SelectionList, type SelectionListSectionDescriptor } from '@/components/ui/selectionList';
import type { DiscussionInitialParticipantV1 } from '@happier-dev/protocol/discussions/participants';
import type { TranscriptAccountActor } from '@happier-dev/session-core/messages';
import { createDiscussionClient } from '@/sync/api/discussions/discussionActions';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { DiscussionParticipantManagement } from './DiscussionParticipantsPopover';
import type { SharePrincipalPresentation } from '@/components/sharing/shareSheetTypes';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { IconName } from '@/components/ui/icons/Icon';
import { useExecutableParticipantSections } from './useExecutableParticipantSections';
import { t } from '@/text';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { resolveAccountActorAvatar, resolveAccountActorPresentation } from '@/sync/domains/account/accountActorPresentation';

type Mutation =
  | Readonly<{
      kind: 'set';
      principal: PrincipalRefV1;
      accessLevel: ShareAccessLevel;
    }>
  | Readonly<{ kind: 'remove'; principal: PrincipalRefV1 }>;

type DiscussionAccessRoster = Omit<DiscussionParticipantRoster, 'participants'>;

type State = Readonly<{
  phase: 'initial' | 'ready' | 'error';
  response: DiscussionAccessRoster | null;
  issue?: ShareUiError;
  operations: Readonly<Record<string, ShareOperationModel>>;
}>;

const IDLE: ShareOperationModel = { kind: 'idle' };
const NO_TEAM_CONTEXTS: readonly [] = [];

/** Discussion relationship facts outrank retained grant display facts. */
export function presentDiscussionAccessPrincipal(input: Readonly<{
  ref: PrincipalRefV1;
  actor?: SessionMessageAccountActorV1 | null;
  display?: Readonly<{ name: string | null; username?: string | null }>;
  scope: ServerAccountScope;
  viewerProfile: ReturnType<typeof useShareViewerProfile>;
}>): SharePrincipalPresentation {
  if (input.ref.kind !== 'account') {
    return presentSharePrincipal({ ref: input.ref, name: input.display?.name, username: input.display?.username });
  }
  if (!input.actor) {
    const principal = presentSharePrincipal({ ref: input.ref, name: input.display?.name, username: input.display?.username,
      viewerAccountId: input.scope.accountId,
      ...(input.ref.accountId === input.scope.accountId ? { profile: input.viewerProfile } : {}) });
    const { id } = resolveAccountActorAvatar({ serverId: input.scope.serverId, accountId: input.ref.accountId }, null, input.scope);
    return { ...principal, avatar: { ...principal.avatar, id } };
  }
  const actor = { ...input.actor, serverId: input.scope.serverId };
  const classification = classifyAccountActorLabelV1(actor, actor.accountId === input.scope.accountId);
  const presentation = resolveAccountActorPresentation(actor, input.scope);
  const profile = classification.kind === 'former' || classification.kind === 'unnamed' ? null : actor.profile;
  const principal = presentSharePrincipal({ ref: input.ref, name: presentation.name,
    username: classification.kind === 'profile' ? actor.profile?.username ?? null : null,
    profile, avatarUrl: presentation.avatar.imageUrl, viewerAccountId: input.scope.accountId });
  return { ...principal, avatar: { ...principal.avatar, id: presentation.avatar.id } };
}

/** One message per Discussion grant refusal; codes stay the Action host's, words stay here. */
function presentDiscussionInviteFailure(code: string, failure?: unknown): ShareUiError {
  switch (code) {
    case 'discussion_manage_denied':
      return {
        code,
        message: t('session.collaboration.discussion.invite.ownerOnly'),
        retryable: false,
      };
    case 'offline':
      return {
        code,
        message: t('session.collaboration.discussion.offline'),
        retryable: true,
      };
    default:
      return {
        code,
        message: resolveActionExecutionErrorMessage(failure ?? { code }, t('session.collaboration.discussion.invite.failed'), { safeToRetry: true }),
        retryable: true,
      };
  }
}

/**
 * Who can read this Discussion, written only through the `discussion.access.grants.*` Actions. The
 * Discussion's grants are the shared resource grant rows, so the one share sheet and the people
 * directory serve them as they serve every other shareable thing; every acknowledged response
 * replaces the roster.
 */
function useDiscussionInviteController(
  input: Readonly<{
    scope: ServerAccountScope;
    discussionId: string;
    /**
     * The Discussion's roster when the page already holds it: it is a superset of the grant list, so
     * the sheet opens on it at once instead of a second read, and follows each roster refresh.
     */
    roster?: DiscussionParticipantRoster | null;
    onChanged?: () => void;
  }>,
) {
  const { scope, discussionId } = input;
  const seed = React.useMemo<DiscussionAccessRoster | null>(() => {
    if (!input.roster || input.roster.discussionId !== discussionId) return null;
    const { participants: _participants, ...grants } = input.roster;
    return grants;
  }, [discussionId, input.roster]);
  const viewerProfile = useShareViewerProfile(scope);
  const client = React.useMemo(
    () => createDiscussionClient({ scope, availability: 'available' }),
    [scope],
  );
  const identity = `${scope.serverId}:${scope.accountId}:${discussionId}`;
  const [state, setState] = React.useState<State>(() => ({
    phase: seed ? 'ready' : 'initial',
    response: seed,
    operations: {},
  }));
  React.useEffect(() => {
    if (seed) setState((previous) => ({ ...previous, phase: 'ready', response: seed, issue: undefined }));
  }, [seed]);
  const seeded = seed !== null;
  const [query, setQuery] = React.useState('');
  const [notice, setNotice] = React.useState<ShareUiReason | undefined>();
  const [revision, setRevision] = React.useState(0);
  const lastMutation = React.useRef(new Map<string, Mutation>());
  const current = React.useRef<string | null>(identity);
  current.current = identity;
  const onChangedRef = React.useRef(input.onChanged);
  onChangedRef.current = input.onChanged;

  const load = React.useCallback(async () => {
    const outcome = await client.listGrants(discussionId).catch(() => null);
    if (current.current !== identity) return;
    setState((previous) =>
      outcome?.kind === 'succeeded'
        ? {
            ...previous,
            phase: 'ready',
            response: outcome.value,
            issue: undefined,
          }
        : {
            ...previous,
            phase: 'error',
            issue: presentDiscussionInviteFailure(
              outcome?.kind === 'failed' ? outcome.errorCode : 'failed',
              outcome,
            ),
          },
    );
  }, [client, discussionId, identity]);
  React.useEffect(() => {
    // A seeded sheet follows roster refreshes instead of reading the grants again.
    if (!seeded) void load();
  }, [load, seeded]);

  const mutate = React.useCallback(
    async (mutation: Mutation) => {
      const key = sessionAccessSubjectKey(mutation.principal);
      lastMutation.current.set(key, mutation);
      setState((previous) => ({
        ...previous,
        operations: {
          ...previous.operations,
          [key]: { kind: mutation.kind === 'remove' ? 'removing' : 'saving' },
        },
      }));
      const outcome = await (
        mutation.kind === 'set'
          ? client.setGrant({
              discussionId,
              principal: mutation.principal,
              accessLevel: mutation.accessLevel,
            })
          : client.removeGrant({ discussionId, principal: mutation.principal })
      ).catch(() => null);
      if (current.current !== identity) return;
      setState((previous) => {
        const { [key]: _settled, ...operations } = previous.operations;
        if (outcome?.kind === 'succeeded') {
          const { changed: _changed, access, ...response } = outcome.value;
          lastMutation.current.delete(key);
          if (access === null)
            return {
              phase: 'ready',
              response: null,
              operations: {},
              issue: presentDiscussionInviteFailure('discussion_manage_denied'),
            };
          return {
            ...previous,
            phase: 'ready',
            response: { ...response, access },
            operations,
            issue: undefined,
          };
        }
        return {
          ...previous,
          operations: {
            ...operations,
            [key]: {
              kind: 'error',
              error: presentDiscussionInviteFailure(
                outcome?.kind === 'failed' ? outcome.errorCode : 'failed',
                outcome,
              ),
            },
          },
        };
      });
      if (outcome?.kind === 'succeeded') onChangedRef.current?.();
      setRevision((value) => value + 1);
    },
    [client, discussionId, identity],
  );

  const response = state.response;
  const accountActors = React.useMemo(() => new Map((response?.accountActors ?? []).map(actor => [actor.accountId, actor])), [response?.accountActors]);
  const isOwner = response?.access === 'owner';
  const editable = isOwner || response?.access === 'admin';
  const grants = React.useMemo<readonly ShareGrantRowModel[]>(
    () =>
      (response?.grants ?? []).map((row) => {
        const principal = presentDiscussionAccessPrincipal({ ref: row.principal, display: row.display, scope, viewerProfile,
          actor: row.principal.kind === 'account' ? accountActors.get(row.principal.accountId) : null });
        return {
          grant: row.principal,
          principal,
          level: {
            kind: 'editable',
            value: row.accessLevel,
            options: isOwner ? ['view', 'edit', 'admin'] : ['view', 'edit'],
          },
          removal: { kind: 'allowed' },
          operation: state.operations[principal.key] ?? IDLE,
        };
      }),
    [
      isOwner,
      accountActors,
      response?.grants,
      scope.accountId,
      state.operations,
      viewerProfile,
    ],
  );
  const owner = response
    ? {
        principal: presentDiscussionAccessPrincipal({
          ref: { kind: 'account', accountId: response.ownerAccountId },
          actor: accountActors.get(response.ownerAccountId), scope, viewerProfile,
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

  const actions = React.useMemo<ShareSheetActions>(
    () => ({
      setQuery,
      retryDirectory: directory.retry,
      loadMore: directory.loadMore,
      // An invitation joins the conversation: invited people can post (lab T2-I).
      addPrincipal: (principal) => {
        void mutate({ kind: 'set', principal, accessLevel: 'edit' });
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
        void mutate({ kind: 'remove', principal: grant });
      },
      confirmRemove: (grant) => {
        void mutate({ kind: 'remove', principal: grant });
      },
      cancelRemove: () => {},
      explain: setNotice,
    }),
    [directory.loadMore, directory.retry, mutate],
  );

  const model: ShareSheetModel = {
    revision,
    editable,
    stale: state.phase === 'error' && response !== null,
    owner,
    grants,
    directory: { query, sections: editable ? directory.sections : [] },
  };
  return {
    model,
    actions,
    issue: state.issue,
    notice,
    loading: state.phase === 'initial',
    retry: () => {
      void load();
    },
  };
}

function createDiscussionInviteAdapter(
  input: Readonly<{
    title: string;
    loading: boolean;
    issue?: ShareUiError;
    notice?: ShareUiReason;
    retry(): void;
    /** Sessions, bots and models that can join and answer (lab T2-I), after the people. */
    agentSections?: readonly SelectionListSectionDescriptor[];
    /** False when no Session, Bot or model can be offered (no Machine): the search then promises people only. */
    offersAgents?: boolean;
    /** Who already answers here (lab T2-S), right under the people who can read it. */
    afterAccess?: readonly SelectionListSectionDescriptor[];
    /** Live words under a person's name ("Here now"). */
    principalTags?: (principal: SharePrincipalPresentation) => readonly string[];
    /** Who can read it, said once under the list; the private note by default. */
    notes?: readonly string[];
    namespace?: string;
  }>,
): ShareSheetAdapter {
  return {
    namespace: input.namespace ?? 'discussion-invite',
    title: input.title,
    ...(input.principalTags ? { principalTags: input.principalTags } : {}),
    // The participants panel's roster is its content; its search is how to add.
    ...(input.namespace ? { browseOnlyWhileAdding: true } : {}),
    ...(input.agentSections && input.offersAgents !== false
      ? { searchPlaceholder: t('session.collaboration.discussion.manage.invitePlaceholder') }
      : {}),
    // The rules row says what it explains: who can read it and how an agent comes to answer.
    ...(input.agentSections ? { helpLabel: t('session.collaboration.discussion.invite.helpTitle') } : {}),
    levels: {
      view: {
        label: t('session.collaboration.discussion.participants.canRead'),
      },
      edit: {
        label: t('session.collaboration.discussion.participants.canPost'),
      },
      admin: { label: t('session.collaboration.discussion.invite.canManage') },
    },
    notes: input.notes ?? [t('session.collaboration.discussion.participants.privateNote')],
    sections: (context) => {
      const notices = [];
      if (input.loading)
        notices.push({
          id: 'loading',
          label: t('common.loading'),
          loading: true,
          disabled: true,
        });
      if (input.issue)
        notices.push({
          id: 'issue',
          label: input.issue.message,
          ...(input.issue.retryable
            ? { onSelect: input.retry, subtitle: t('common.retry') }
            : {}),
        });
      if (input.notice)
        notices.push({
          id: 'notice',
          label: input.notice.message,
          disabled: true,
        });
      // Agents to add appear with the people to add: once someone starts adding.
      const trailing: SelectionListSectionDescriptor[] = [
        ...(context.revealSuggestions !== false ? input.agentSections ?? [] : []),
        ...(notices.length
          ? [{ kind: 'static' as const, id: 'status', options: notices }]
          : []),
      ];
      return {
        ...(input.afterAccess?.length ? { afterAccess: input.afterAccess } : {}),
        ...(trailing.length ? { trailing } : {}),
      };
    },
  };
}

/** What the participants panel adds to the one share sheet: who answers here and live presence. */
type DiscussionRosterComposition = Readonly<{
  afterAccess?: readonly SelectionListSectionDescriptor[];
  notes?: readonly string[];
  principalTags?: (principal: SharePrincipalPresentation) => readonly string[];
}>;

function DiscussionInviteSheet(
  props: Readonly<{
    scope: ServerAccountScope;
    accountLifetime?: ServerAccountScopeLifetime;
    discussionId: string;
    discussionTitle: string;
    roster?: DiscussionParticipantRoster | null;
    management?: DiscussionParticipantManagement | null;
    onChanged?: () => void;
    onRequestClose: () => void;
    /** `compact` is the header's Invite; `inline` is the participants panel, whose search invites. */
    presentation?: 'compact' | 'inline';
    composition?: DiscussionRosterComposition;
    maxHeight?: number;
  }>,
) {
  const controller = useDiscussionInviteController({
    scope: props.scope,
    discussionId: props.discussionId,
    roster: props.roster ?? null,
    onChanged: props.onChanged,
  });
  const shared = {
    controller,
    discussionTitle: props.discussionTitle,
    onRequestClose: props.onRequestClose,
    presentation: props.presentation ?? 'compact',
    ...(props.composition ? { composition: props.composition } : {}),
    ...(props.maxHeight === undefined ? {} : { maxHeight: props.maxHeight }),
  } as const;
  return (
    <View testID={props.presentation === 'inline' ? 'discussion-participants-sheet' : 'discussion-invite-panel'} style={inviteStyles.panel}>
      {props.accountLifetime && props.management ? (
        <DiscussionInviteSheetWithAgents
          {...shared}
          accountLifetime={props.accountLifetime}
          management={props.management}
          roster={props.roster ?? null}
        />
      ) : (
        <DiscussionInviteShareSheet {...shared} />
      )}
    </View>
  );
}

type DiscussionShareSheetShared = Readonly<{
  controller: ReturnType<typeof useDiscussionInviteController>;
  discussionTitle: string;
  onRequestClose: () => void;
  presentation: 'compact' | 'inline';
  composition?: DiscussionRosterComposition;
  /** A popover host's bound: the sheet's list scrolls within it (the surface itself does not scroll). */
  maxHeight?: number;
}>;

function DiscussionInviteSheetWithAgents(
  props: DiscussionShareSheetShared & Readonly<{
    accountLifetime: ServerAccountScopeLifetime;
    management: DiscussionParticipantManagement;
    roster: DiscussionParticipantRoster | null;
  }>,
) {
  const { inviteExecutable, operation } = props.management;
  const [readinessSessionId, setReadinessSessionId] = React.useState<string | null>(null);
  const onChoose = React.useCallback(
    (selection: ExecutableParticipantSelectionV1) => { void inviteExecutable(selection); },
    [inviteExecutable],
  );
  const { sections: agentSections, recipeEditor, offersAgents } = useExecutableParticipantSections({
    accountLifetime: props.accountLifetime,
    roster: props.roster,
    busy: operation.kind === 'working',
    sessionsContext: t('session.collaboration.discussion.manage.sessionCandidate'),
    onChoose,
    enabled: props.controller.model.editable,
    readinessSessionId,
    onReadinessSessionChange: setReadinessSessionId,
    query: props.controller.model.directory.query,
  });
  const { accountLifetime: _lifetime, management: _management, roster: _roster, ...shared } = props;
  return recipeEditor ?? <DiscussionInviteShareSheet {...shared} agentSections={agentSections} offersAgents={offersAgents} />;
}

function DiscussionInviteShareSheet(
  props: DiscussionShareSheetShared & Readonly<{
    agentSections?: readonly SelectionListSectionDescriptor[];
    offersAgents?: boolean;
  }>,
) {
  const { controller } = props;
  const inline = props.presentation === 'inline';
  const adapter = createDiscussionInviteAdapter({
    title: inline
      ? t('session.collaboration.discussion.participants.title')
      : t('session.collaboration.discussion.invite.title', { title: props.discussionTitle }),
    loading: controller.loading,
    ...(controller.issue ? { issue: controller.issue } : {}),
    ...(controller.notice ? { notice: controller.notice } : {}),
    retry: controller.retry,
    ...(props.agentSections ? { agentSections: props.agentSections } : {}),
    ...(props.offersAgents === false ? { offersAgents: false } : {}),
    ...(props.composition?.afterAccess ? { afterAccess: props.composition.afterAccess } : {}),
    ...(props.composition?.principalTags ? { principalTags: props.composition.principalTags } : {}),
    ...(props.composition?.notes ? { notes: props.composition.notes } : {}),
    ...(inline ? { namespace: 'discussion-participants' } : {}),
  });
  return (
    <ShareSheet host={SHARE_SHEET_HOST}
      model={controller.model}
      actions={controller.actions}
      adapter={adapter}
      presentation={props.presentation}
      onRequestClose={props.onRequestClose}
      testID={inline ? 'discussion-participants-share' : 'discussion-invite-sheet'}
      {...(props.maxHeight === undefined ? {} : { maxHeight: props.maxHeight })}
    />
  );
}

/** The participants panel's body (lab T2-S): the one share sheet, its search inviting anyone, the roster below. */
export function DiscussionParticipantsSheet(
  props: Readonly<{
    scope: ServerAccountScope;
    accountLifetime?: ServerAccountScopeLifetime;
    discussionId: string;
    discussionTitle: string;
    roster: DiscussionParticipantRoster | null;
    management: DiscussionParticipantManagement | null;
    afterAccess: readonly SelectionListSectionDescriptor[];
    principalTags: (principal: SharePrincipalPresentation) => readonly string[];
    notes: readonly string[];
    onChanged?: () => void;
    onRequestClose: () => void;
    /** A pane's measured height: the roster list scrolls within it instead of running past the pane's foot. */
    maxHeight?: number;
  }>,
) {
  const noteKey = props.notes.join('\n');
  const composition = React.useMemo(
    () => ({ afterAccess: props.afterAccess, principalTags: props.principalTags, notes: noteKey.split('\n') }),
    [noteKey, props.afterAccess, props.principalTags],
  );
  return (
    <DiscussionInviteSheet
      scope={props.scope}
      {...(props.accountLifetime ? { accountLifetime: props.accountLifetime } : {})}
      discussionId={props.discussionId}
      discussionTitle={props.discussionTitle}
      roster={props.roster}
      management={props.management}
      {...(props.onChanged ? { onChanged: props.onChanged } : {})}
      onRequestClose={props.onRequestClose}
      presentation="inline"
      composition={composition}
      {...(props.maxHeight === undefined ? {} : { maxHeight: props.maxHeight })}
    />
  );
}

/**
 * The heading of a Discussion's floating sheets (Participants, Invite): a quiet mark, the sheet's
 * title and one line saying which Discussion and who is in it.
 */
export function DiscussionSheetHeader(
  props: Readonly<{ icon: IconName; title: string; subtitle: string }>,
) {
  const { theme } = useUnistyles();
  return (
    <View style={inviteStyles.sheetHeader}>
      <Icon name={props.icon} size={ICON_SIZE.md} color={theme.colors.text.secondary} />
      <View style={inviteStyles.sheetHeaderText}>
        <Text style={inviteStyles.sheetTitle} numberOfLines={1}>{props.title}</Text>
        <Text style={inviteStyles.sheetSubtitle} numberOfLines={1}>{props.subtitle}</Text>
      </View>
    </View>
  );
}

/**
 * Where a participant change stands, one line under the roster: saving, waiting for an approval
 * (with its request), still checking, or failed with Try again. Done and idle say nothing.
 */
export function DiscussionParticipantOperationLine(
  props: Readonly<{
    management: DiscussionParticipantManagement;
    serverId: string;
  }>,
) {
  const router = useRouter();
  const { operation, retry } = props.management;
  if (operation.kind === 'idle' || operation.kind === 'succeeded') return null;
  if (operation.kind === 'approval_pending') {
    return (
      <ActionApprovalPendingNotice
        presentation="line"
        testID="discussion-participants-approval"
        message={t('approvals.status.open')}
        onOpenApproval={() => router.push(buildApprovalHref(operation.artifactId, props.serverId))}
      />
    );
  }
  if (operation.kind === 'working') {
    return (
      <EmptyState
        testID="discussion-participants-operation"
        layout="line"
        lineDensity="menu"
        lineLoading
        title={t('session.collaboration.discussion.manage.working')}
      />
    );
  }
  return (
    <EmptyState
      testID="discussion-participants-operation"
      layout="line"
      lineDensity="menu"
      title={
        operation.kind === 'checking'
          ? t('session.collaboration.discussion.manage.checking')
          : t('session.collaboration.discussion.manage.failed')
      }
      primaryAction={{
        label: t('session.collaboration.discussion.retry'),
        onPress: () => retry(),
        testID: 'discussion-participants-retry',
      }}
    />
  );
}

const inviteStyles = StyleSheet.create((theme) => ({
  panel: { minWidth: 0, minHeight: 0 },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s10,
    paddingHorizontal: theme.space.s12,
    paddingTop: theme.space.s4,
    paddingBottom: theme.space.s8,
  },
  sheetHeaderText: { flex: 1, minWidth: 0, gap: theme.space.s2 },
  sheetTitle: { ...Typography.variant('heading', 'semiBold'), color: theme.colors.text.primary },
  sheetSubtitle: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
  header: { paddingTop: theme.space.s8 },
}));

/** Who a New Discussion invites, kept in its creation draft until the create is observed. */
export type DiscussionInviteDraft = Readonly<{
  participants: readonly DiscussionInitialParticipantV1[];
  onChange: (participants: readonly DiscussionInitialParticipantV1[]) => void;
  /** Names the page already resolved for the chosen people. */
  accounts: ReadonlyMap<string, TranscriptAccountActor>;
}>;

type DiscussionInviteButtonProps = Readonly<{
  scope: ServerAccountScope;
  accountLifetime?: ServerAccountScopeLifetime;
}> & (
  | Readonly<{
      draft?: undefined;
      discussionId: string;
      discussionTitle: string;
      roster?: DiscussionParticipantRoster | null;
      management?: DiscussionParticipantManagement | null;
      onChanged?: () => void;
    }>
  /** New Discussion (lab T2-ST): the same Invite chooses people and agents before the Discussion exists. */
  | Readonly<{ draft: DiscussionInviteDraft; accountLifetime: ServerAccountScopeLifetime }>
);

function participantKey(participant: DiscussionInitialParticipantV1): string {
  return participant.kind === 'account' ? `account:${participant.accountId}` : `session:${participant.sessionId}`;
}

/** The pre-create body: one multiple-choice list of people, then the viewer's Sessions; each row toggles. */
function DiscussionDraftInviteList(props: Readonly<{
  accountLifetime: ServerAccountScopeLifetime;
  draft: DiscussionInviteDraft;
  maxHeight: number;
}>) {
  const { draft } = props;
  const [readinessSessionId, setReadinessSessionId] = React.useState<string | null>(null);
  const latest = React.useRef(draft);
  latest.current = draft;
  const toggle = React.useCallback((participant: DiscussionInitialParticipantV1) => {
    const current = latest.current.participants;
    const key = participantKey(participant);
    latest.current.onChange(current.some(entry => participantKey(entry) === key)
      ? current.filter(entry => participantKey(entry) !== key)
      : [...current, participant]);
  }, []);
  const onChoose = React.useCallback((selection: ExecutableParticipantSelectionV1, facts?: Readonly<{ bot: boolean }>) => {
    if (selection.kind !== 'session') return;
    const roomBot = latest.current.participants.find(participant => participant.kind === 'session' && participant.answerPolicy);
    const answerPolicy = roomBot?.kind === 'session' ? roomBot.answerPolicy : 'when_mentioned';
    toggle({ kind: 'session', sessionId: selection.session.sessionId, ...(facts?.bot ? { answerPolicy } : {}) });
  }, [toggle]);
  const viewerAccountId = props.accountLifetime.scope.accountId;
  const people = React.useMemo(() => ({
    title: t('session.collaboration.discussion.participants.peopleGroup'),
    onChoose: toggle,
    chosen: draft.participants.flatMap(participant => participant.kind === 'account'
      ? [presentSharePrincipal({ ref: participant, profile: draft.accounts.get(participant.accountId)?.profile ?? null, viewerAccountId })] : []),
  }), [draft.accounts, draft.participants, toggle, viewerAccountId]);
  const { sections, peopleSection } = useExecutableParticipantSections({
    accountLifetime: props.accountLifetime,
    enabled: true,
    sessionsContext: t('session.collaboration.discussion.manage.sessionCandidate'),
    readinessSessionId,
    onReadinessSessionChange: setReadinessSessionId,
    onChoose,
    people,
  });
  const selectedIds = React.useMemo(() => new Set(draft.participants.map(participantKey)), [draft.participants]);
  const rootStep = React.useMemo(() => ({
    id: 'root',
    inputPlaceholder: t('session.collaboration.discussion.newPage.invitePlaceholder'),
    sections: peopleSection ? [peopleSection, ...sections] : sections,
  }), [peopleSection, sections]);
  return (
    <SelectionList
      testID="discussion-new-invite-list"
      rootStep={rootStep}
      selection={{ kind: 'multiple', selectedIds }}
      listAccessibilityLabel={t('session.collaboration.discussion.invite.button')}
      onSelect={() => undefined}
      onRequestClose={() => undefined}
      disableTransitions
      maxHeight={props.maxHeight}
      heightBehavior="fixedToMaxHeight"
    />
  );
}

/**
 * The header's Invite (lab T2-A/T2-I): the one share sheet, compact, hung from the button, adding people
 * and Teams to who can read and post here. Before create it chooses who the new Discussion starts with.
 */
export const DiscussionInviteButton = React.memo(
  function DiscussionInviteButton(props: DiscussionInviteButtonProps) {
    const { theme } = useUnistyles();
    const phone = useSurfaceStateSize() === 'phone';
    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<View>(null);
    const close = React.useCallback(() => setOpen(false), []);
    // The candidate list owns its scroll (SelectionList contract), so the popover's surface does not
    // scroll; the list gets what the pinned header and operation line leave of the popover's height.
    const [chromeHeights, setChromeHeights] = React.useState({ header: 0, footer: 0 });
    const measureChrome = React.useCallback((part: 'header' | 'footer', height: number) => {
      const rounded = Math.round(height);
      setChromeHeights((current) => current[part] === rounded ? current : { ...current, [part]: rounded });
    }, []);
    const inviteComposition = React.useMemo(
      () => ({ notes: [t('session.collaboration.discussion.participants.mentionNote')] }),
      [],
    );
    return (
      <>
        <View ref={anchorRef} collapsable={false}>
          {/* A phone's band keeps only quiet marks beside the title, so Invite is its glyph there. */}
          {phone ? (
            <IconButton
              testID="session-discussion-invite"
              iconName="user-plus"
              variant="plain"
              iconSize={ICON_SIZE.sm}
              size={34}
              accessibilityLabel={t('session.collaboration.discussion.invite.button')}
              expanded={open}
              hasPopup="dialog"
              onPress={() => setOpen((value) => !value)}
            />
          ) : (
            <ToolbarButton
              testID="session-discussion-invite"
              label={t('session.collaboration.discussion.invite.button')}
              icon={
                <Icon
                  name="plus"
                  size={ICON_SIZE.xs}
                  color={theme.colors.text.primary}
                />
              }
              onPress={() => setOpen((value) => !value)}
              size="sm"
            />
          )}
        </View>
        {open ? (
          <Popover
            open={open}
            anchorRef={anchorRef}
            placement="bottom"
            gap={6}
            maxHeightCap={640}
            maxWidthCap={440}
            onRequestClose={close}
            backdrop={{ enabled: false }}
            portal={MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS}
            // A phone gets the shared bottom sheet (lab T2-Ip); the invite's own header names it there too.
            phonePresentation="sheet"
            sheetHeader="none"
            accessibilityLabel={props.draft
              ? t('session.collaboration.discussion.newPage.inviteTitle')
              : t('session.collaboration.discussion.invite.title', { title: props.discussionTitle })}
          >
            {({ maxHeight }) => {
              const listMaxHeight = Math.max(0, maxHeight - chromeHeights.header - chromeHeights.footer);
              return (
              <FloatingOverlay
                maxHeight={maxHeight}
                scrollEnabled={false}
                surfaceChrome="theme"
                // Which Discussion this adds to stays in view while the candidates scroll.
                header={<View style={inviteStyles.header} onLayout={(event) => measureChrome('header', event.nativeEvent.layout.height)}>
                  <DiscussionSheetHeader
                    icon="user-plus"
                    title={props.draft
                      ? t('session.collaboration.discussion.newPage.inviteTitle')
                      : t('session.collaboration.discussion.invite.title', { title: props.discussionTitle })}
                    subtitle={props.draft
                      ? t('session.collaboration.discussion.participants.mentionNote')
                      : t('session.collaboration.discussion.manage.inviteSubtitle')}
                  />
                </View>}
                // Where an agent invitation stands stays visible under any scroll position.
                footer={!props.draft && props.management ? <View onLayout={(event) => measureChrome('footer', event.nativeEvent.layout.height)}>
                  <DiscussionParticipantOperationLine
                    management={props.management}
                    serverId={props.scope.serverId}
                  /></View> : undefined}
              >
                {props.draft ? (
                  <DiscussionDraftInviteList accountLifetime={props.accountLifetime} draft={props.draft} maxHeight={listMaxHeight} />
                ) : (
                <DiscussionInviteSheet
                  scope={props.scope}
                  {...(props.accountLifetime ? { accountLifetime: props.accountLifetime } : {})}
                  roster={props.roster ?? null}
                  management={props.management ?? null}
                  discussionId={props.discussionId}
                  discussionTitle={props.discussionTitle}
                  // The header already says who can read it; Details adds only the mention rule.
                  composition={inviteComposition}
                  onChanged={props.onChanged}
                  onRequestClose={close}
                  maxHeight={listMaxHeight}
                />
                )}
              </FloatingOverlay>
              );
            }}
          </Popover>
        ) : null}
      </>
    );
  },
);
