import {
  happierPageTextMetrics,
  HAPPIER_WORK_PANE_METRICS,
} from '@happier-dev/plugin-ui/presentation';
import {
  ActionApprovalRequestCreatedResultSchema,
  type ActionExecuteResult,
} from '@happier-dev/protocol/actions/actionExecutionResult';
import type { PromptDocArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';
import * as React from 'react';
import { type LayoutChangeEvent, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { ActionSettingsTargetModeControl } from '@/components/settings/actions/ActionSettingsTargetModeControl';
import { normalizeActionsSettings } from '@/components/settings/actions/normalizeActionsSettings';
import { promptCollectionItemHref } from '@/components/settings/prompts/collection/promptCollectionModel';
import { WorkSection } from '@/components/sessions/work/WorkSection';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { isSessionAccessOwner } from '@/sync/engine/sessions/normalizeSessionAccessProjection';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { areServerProfileIdentifiersEquivalent, getServerProfileById } from '@/sync/domains/server/serverProfiles';
import {
  useActiveServerAccountScope,
  useArtifacts,
  useSettingMutable,
} from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import {
  sessionInstructionsActions,
  type SessionInstructionsTarget,
} from '@/sync/ops/promptLibrary/sessionInstructions';
import { t } from '@/text';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { useDeviceType } from '@/utils/platform/responsive';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
  resolveSessionInstructionsPolicy,
  useSessionInstructionsDetail,
  type SessionInstructionsAccess,
  type SessionInstructionsSource,
} from '../useSessionInstructionsSource';

/** The rendered document reads in this many body lines before "More" (lab `b-work A`). */
const COLLAPSED_LINES = 4;

type SaveState = 'idle' | 'pending';

/** Who may read this Session's Instructions here: the owner, or nobody (shared viewers never see them). */
export function resolveSessionInstructionsAccess(
  session: Session | null,
): SessionInstructionsAccess {
  if (!session) return 'unavailable';
  if (!isSessionAccessOwner(session.access, session.accessLevel))
    return 'owner_private';
  return readSessionOwnerMetadataView(session) ? 'readable' : 'unavailable';
}

/** An Action outcome as the section reports it: applied, waiting for approval, or refused. */
function readOutcome(
  result: ActionExecuteResult,
): 'applied' | 'pending' | 'refused' {
  if (!result.ok) return 'refused';
  return ActionApprovalRequestCreatedResultSchema.safeParse(result.result)
    .success
    ? 'pending'
    : 'applied';
}

/**
 * Work › Instructions (plan 61 §8, lab `b-work A/S`): the Session's attached Prompt Library document,
 * rendered in place and clamped with More, its source line, ✎ to the Prompt Library editor, and the
 * real Agent edits control. Every state is cause-specific and keeps its space: no attachment invites
 * one (Create · Attach existing); a valid empty document invites content; a refresh keeps the last
 * body; deleted, wrong-kind and unreadable documents offer repair or Detach; locked and owner-private
 * Sessions never disclose content. Attach, Create and Detach are the public `session.instructions.set`
 * and `prompt_doc.create` Actions; this section is a domain body, never another editor or store.
 */
export const SessionInstructionsSection = React.memo(
  function SessionInstructionsSection(
    props: Readonly<{
      session: Session;
      serverId: string;
    }>,
  ) {
    const { session, serverId } = props;
    const access = resolveSessionInstructionsAccess(session);
    const ownerMetadata = React.useMemo(
      () => readSessionOwnerMetadataView(session),
      [session],
    );
    const source = useSessionInstructionsDetail({
      sessionId: session.id,
      serverId,
      ownerMetadata,
      access,
    });
    return (
      <SessionInstructionsBody
        session={session}
        serverId={serverId}
        source={source}
      />
    );
  },
);

export const SessionInstructionsBody = React.memo(function SessionInstructionsBody(
  props: Readonly<{
    session: Session;
    serverId: string;
    source: SessionInstructionsSource;
  }>,
) {
  const styles = stylesheet;
  const { session, serverId, source } = props;
  const router = useRouter();
  const homeName = resolveHomeDisplayLabel(getServerProfileById(serverId), serverId);
  const [saveState, setSaveState] = React.useState<SaveState>('idle');
  const target = React.useMemo<SessionInstructionsTarget>(
    () => ({
      sessionId: session.id,
      serverId,
      expectedMetadataRevision: session.metadataVersion,
    }),
    [serverId, session.id, session.metadataVersion],
  );
  const ref = source.ref;
  const document = source.document;

  const edit = React.useCallback(() => {
    if (!ref) return;
    router.push(
      promptCollectionItemHref('doc', ref.artifactId, {
        serverId: ref.serverId ?? serverId,
      }) as never,
    );
  }, [ref, router, serverId]);

  const settle = React.useCallback(
    async (run: () => Promise<ActionExecuteResult>): Promise<boolean> => {
      setSaveState('pending');
      try {
        const outcome = readOutcome(await run());
        if (outcome === 'refused')
          Modal.alert(
            t('sessionInstructions.title'),
            t('sessionInstructions.refused'),
          );
        // An approval request leaves the line saying it is waiting; the accepted write re-renders the section.
        if (outcome !== 'pending') setSaveState('idle');
        return outcome === 'applied';
      } catch {
        setSaveState('idle');
        Modal.alert(
          t('sessionInstructions.title'),
          t('sessionInstructions.refused'),
        );
        return false;
      }
    },
    [],
  );

  const attach = React.useCallback(
    (next: PromptDocArtifactRefV1) => {
      fireAndForget(
        settle(() => sessionInstructionsActions.set(target, next)),
        { tag: 'SessionInstructions.attach' },
      );
    },
    [settle, target],
  );
  const create = React.useCallback(() => {
    fireAndForget(
      (async () => {
        const created: { ref: PromptDocArtifactRefV1 | null } = { ref: null };
        const applied = await settle(async () => {
          const authored = await sessionInstructionsActions.createAndAttach(
            target,
            {
              title: getSessionName(session, serverId),
              markdown: '',
            },
          );
          created.ref = authored.createdRef;
          return authored.result;
        });
        const opened = created.ref;
        if (applied && opened)
          router.push(
            promptCollectionItemHref('doc', opened.artifactId, {
              serverId,
            }) as never,
          );
      })(),
      { tag: 'SessionInstructions.create' },
    );
  }, [router, serverId, session, settle, target]);
  const detach = React.useCallback(() => {
    fireAndForget(
      (async () => {
        const confirmed = await Modal.confirm(
          t('sessionInstructions.detach'),
          t('sessionInstructions.detachHelp'),
          {
            confirmText: t('sessionInstructions.detach'),
          },
        );
        if (confirmed)
          await settle(() => sessionInstructionsActions.set(target, null));
      })(),
      { tag: 'SessionInstructions.detach' },
    );
  }, [settle, target]);

  const status = source.status;
  const repairable =
    status === 'not_found' || status === 'wrong_kind' || status === 'malformed';
  const showEdit = ref !== null && document !== null;
  return (
    <WorkSection
      testID="session-work-instructions"
      anatomy="page"
      title={t('sessionInstructions.title')}
      count=""
      info={t('sessionInstructions.description')}
      nativeID="instructions"
      loading={status === 'loading' || status === 'inactive'}
      action={
        showEdit ? (
          <IconButton
            testID="session-work-instructions.edit"
            iconName="pencil-simple"
            variant="plain"
            accessibilityLabel={t('sessionInstructions.edit')}
            tooltip={t('sessionInstructions.edit')}
            onPress={edit}
          />
        ) : null
      }
    >
      {saveState === 'pending' ? (
        <SurfaceFreshnessLine
          testID="session-work-instructions.pending"
          busy
          reason={t('sessionInstructions.savePending')}
        />
      ) : status === 'refreshing' ? (
        <SurfaceFreshnessLine
          testID="session-work-instructions.refreshing"
          busy
          reason={t('sessionInstructions.refreshing')}
        />
      ) : status === 'unavailable' && document ? (
        <SurfaceFreshnessLine
          testID="session-work-instructions.stale"
          tone="warning"
          reason={t('sessionInstructions.offline', { home: homeName })}
          action={{
            label: t('common.retry'),
            onPress: () => {
              fireAndForget(source.retry(), {
                tag: 'SessionInstructions.retry',
              });
            },
          }}
        />
      ) : null}
      {document ? (
        document.markdown.trim().length > 0 ? (
          <ClampedInstructions
            markdown={document.markdown}
            title={document.title}
            stale={source.stale}
          />
        ) : (
          <Item
            testID="session-work-instructions.empty"
            title={t('sessionInstructions.empty')}
            showChevron={false}
            onPress={edit}
          />
        )
      ) : status === 'none' ? (
        <View style={styles.invite}>
          <Text style={styles.inviteText}>{t('sessionInstructions.none')}</Text>
          <View style={styles.actions}>
            <RoundButton
              testID="session-work-instructions.create"
              size="small"
              display="secondary"
              title={t('sessionInstructions.create')}
              onPress={create}
              disabled={saveState === 'pending'}
            />
            <AttachExistingInstructions
              serverId={serverId}
              title={t('sessionInstructions.attach')}
              onAttach={attach}
            />
          </View>
        </View>
      ) : repairable ? (
        <View style={styles.repair}>
          <Item
            testID={`session-work-instructions.${status}`}
            icon={<Icon name="warning" />}
            title={
              status === 'not_found'
                ? t('sessionInstructions.missing')
                : status === 'wrong_kind'
                  ? t('sessionInstructions.wrongKind')
                  : t('sessionInstructions.invalid')
            }
            showChevron={false}
          />
          <View style={styles.actions}>
            <AttachExistingInstructions
              serverId={serverId}
              title={
                status === 'not_found'
                  ? t('sessionInstructions.attach')
                  : t('sessionInstructions.chooseDocument')
              }
              onAttach={attach}
            />
            <RoundButton
              testID="session-work-instructions.detach"
              size="small"
              display="secondary"
              title={t('sessionInstructions.detach')}
              onPress={detach}
            />
          </View>
        </View>
      ) : status === 'locked' || status === 'owner_private' ? (
        <Item
          testID={`session-work-instructions.${status}`}
          icon={<Icon name={status === 'locked' ? 'lock' : 'users'} />}
          title={
            status === 'locked'
              ? t('sessionInstructions.locked')
              : t('sessionInstructions.ownerPrivate')
          }
          showChevron={false}
        />
      ) : status === 'unavailable' ? (
        <SurfaceFreshnessLine
          testID="session-work-instructions.unavailable"
          tone="warning"
          reason={t('sessionInstructions.offline', { home: homeName })}
          action={{
            label: t('common.retry'),
            onPress: () => {
              fireAndForget(source.retry(), {
                tag: 'SessionInstructions.retry',
              });
            },
          }}
        />
      ) : null}
      {document ? <SessionInstructionsAgentEdits serverId={serverId} /> : null}
    </WorkSection>
  );
});

/**
 * The rendered document, clamped to a few lines with More (lab `b-work A`). The clamp is measured,
 * not guessed: the body lays out at its natural height inside a clipped frame, and More appears only
 * when that height exceeds the clamp. The quiet line beneath names where it lives.
 */
function ClampedInstructions(
  props: Readonly<{ markdown: string; title: string; stale: boolean }>,
) {
  const styles = stylesheet;
  const lineHeight = happierPageTextMetrics('pageDescription').lineHeight;
  const clampHeight = lineHeight * COLLAPSED_LINES;
  const [expanded, setExpanded] = React.useState(false);
  const [fullHeight, setFullHeight] = React.useState(0);
  const onLayout = React.useCallback(
    (event: LayoutChangeEvent) =>
      setFullHeight(event.nativeEvent.layout.height),
    [],
  );
  const overflows = !expanded && fullHeight > clampHeight + 1;
  return (
    <View style={styles.inset}>
      <View style={expanded ? null : [styles.clip, { maxHeight: clampHeight }]}>
        <View onLayout={onLayout}>
          <MarkdownView
            testID="session-work-instructions.body"
            markdown={props.markdown}
            textStyle={styles.body}
          />
        </View>
      </View>
      {overflows ? (
        <Text
          testID="session-work-instructions.more"
          accessibilityRole="button"
          style={styles.more}
          onPress={() => setExpanded(true)}
        >
          {t('sessionInstructions.more')}
        </Text>
      ) : null}
      <Text
        style={[styles.meta, props.stale ? styles.metaStale : null]}
        numberOfLines={2}
      >
        {t('sessionInstructions.source', { title: props.title })}
      </Text>
    </View>
  );
}

/**
 * Agent edits: the real Ask first / Allowed control over the Account's `prompt_doc.update` setting for
 * the Agent surface, scoped in words to every Session on it. Only where this device holds that Account.
 */
function SessionInstructionsAgentEdits(props: Readonly<{ serverId: string }>) {
  const accountScope = useActiveServerAccountScope();
  const deviceType = useDeviceType();
  const [rawSettings, setRawSettings] = useSettingMutable('actionsSettingsV1');
  const settings = React.useMemo(
    () => normalizeActionsSettings(rawSettings),
    [rawSettings],
  );
  const policy = React.useMemo(
    () =>
      resolveSessionInstructionsPolicy({
        settings,
        targetId: 'agent',
        onChange: (next) => setRawSettings(normalizeActionsSettings(next)),
      }),
    [setRawSettings, settings],
  );
  if (
    !accountScope ||
    !areServerProfileIdentifiersEquivalent(
      accountScope.serverId,
      props.serverId,
    )
  )
    return null;
  const stacked = deviceType === 'phone';
  return (
    <Item
      testID="session-work-instructions.agentEdits"
      title={t('sessionInstructions.agentEdits')}
      subtitle={t('sessionInstructions.policyScope')}
      showChevron={false}
      accessoryLayout={stacked ? 'stacked' : 'adaptive'}
      rightElement={
        <ActionSettingsTargetModeControl
          controlState={policy.controlState}
          accessibilityLabel={t('sessionInstructions.agentEdits')}
          testIDPrefix="session-work-instructions.agentEdits"
          layout={stacked ? 'stacked' : 'inline'}
          onChange={(value) => {
            if (value !== 'on') policy.setValue(value);
          }}
        />
      }
    />
  );
}

/**
 * Attach existing: the account's Prompt Library documents in the shared searchable menu. The document
 * list mounts only while the menu is open, so a closed Work section subscribes to no library rows.
 */
function AttachExistingInstructions(
  props: Readonly<{
    serverId: string;
    title: string;
    onAttach: (ref: PromptDocArtifactRefV1) => void;
  }>,
) {
  const accountScope = useActiveServerAccountScope();
  const anchorRef = React.useRef<View>(null);
  const [open, setOpen] = React.useState(false);
  // The library list is the active Account's; another Home's Session attaches from its own device focus.
  if (
    !accountScope ||
    !areServerProfileIdentifiersEquivalent(
      accountScope.serverId,
      props.serverId,
    )
  )
    return null;
  return (
    <View ref={anchorRef} collapsable={false}>
      <RoundButton
        testID="session-work-instructions.attach"
        size="small"
        display="secondary"
        title={props.title}
        onPress={() => setOpen(true)}
      />
      {open ? (
        <AttachExistingMenu
          anchorRef={anchorRef}
          serverId={props.serverId}
          onClose={() => setOpen(false)}
          onAttach={(ref) => {
            setOpen(false);
            props.onAttach(ref);
          }}
        />
      ) : null}
    </View>
  );
}

/**
 * The account's Prompt Library in the shared searchable menu: documents, and skills too when the
 * caller attaches context rather than Instructions (Work › Context's "Add document").
 */
export function AttachExistingMenu(
  props: Readonly<{
    anchorRef: React.RefObject<View | null>;
    serverId: string;
    onClose: () => void;
    onAttach: (ref: PromptDocArtifactRefV1) => void;
    /** Given by a caller that also attaches skills; they are offered only then. */
    onAttachSkill?: (artifactId: string) => void;
    testID?: string;
    searchPlaceholder?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const artifacts = useArtifacts();
  const offerSkills = props.onAttachSkill !== undefined;
  const skillIds = React.useMemo(
    () =>
      new Set(
        offerSkills
          ? artifacts
              .filter((artifact) => artifact.header?.kind === 'prompt_bundle.v2')
              .map((artifact) => artifact.id)
          : [],
      ),
    [artifacts, offerSkills],
  );
  const items = React.useMemo(
    (): DropdownMenuItem[] =>
      artifacts
        .filter(
          (artifact) =>
            artifact.header?.kind === 'prompt_doc.v2' ||
            (offerSkills && artifact.header?.kind === 'prompt_bundle.v2'),
        )
        .map((artifact) => ({
          id: artifact.id,
          title:
            typeof artifact.header?.title === 'string'
              ? artifact.header.title
              : (artifact.title ?? t('promptLibrary.untitledPrompt')),
          icon: (
            <Icon
              name={
                artifact.header?.kind === 'prompt_bundle.v2'
                  ? 'sparkle'
                  : 'file-text'
              }
              size={18}
              color={theme.colors.text.secondary}
            />
          ),
        })),
    [artifacts, offerSkills, theme.colors.text.secondary],
  );
  return (
    <DropdownMenu
      testID={props.testID ?? 'session-work-instructions.attachMenu'}
      open
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
      items={items}
      selectedId={null}
      search
      searchPlaceholder={
        props.searchPlaceholder ?? t('sessionInstructions.attachTitle')
      }
      popoverAnchorRef={props.anchorRef}
      matchTriggerWidth={false}
      onSelect={(id) => {
        const artifactId = String(id);
        if (skillIds.has(artifactId)) props.onAttachSkill?.(artifactId);
        else
          props.onAttach({
            kind: 'doc',
            serverId: props.serverId,
            artifactId,
          });
      }}
    />
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  // Text is not an `Item`, so it takes the Work rows' text edge itself.
  inset: {
    paddingHorizontal: HAPPIER_WORK_PANE_METRICS.rowInsetPx,
    gap: 6,
  },
  clip: {
    overflow: 'hidden',
  },
  body: {
    ...Typography.default(),
    ...happierPageTextMetrics('pageDescription'),
    color: theme.colors.text.primary,
  },
  more: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
    alignSelf: 'flex-start',
  },
  meta: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.tertiary,
  },
  metaStale: {
    color: theme.colors.state.warning.foreground,
  },
  invite: {
    paddingHorizontal: HAPPIER_WORK_PANE_METRICS.rowInsetPx,
    gap: 10,
  },
  inviteText: {
    ...Typography.default(),
    ...happierPageTextMetrics('pageDescription'),
    color: theme.colors.text.secondary,
  },
  repair: {
    gap: 6,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: HAPPIER_WORK_PANE_METRICS.rowInsetPx,
  },
}));
