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
import { StyleSheet } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { PROMPT_DOC_WRITE_RESULT_KEY, promptDocWriteNeedsAttention } from '@/components/approvals/promptDocWriteResultCopy';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { ActionSettingsTargetModeControl } from '@/components/settings/actions/ActionSettingsTargetModeControl';
import { ACTIONS_PROMPT_DOCUMENT_SETTINGS } from '@/components/settings/actions/actionsSettings';
import { useSettingActionWriter } from '@/components/settings/catalog/useSettingActionWriter';
import { normalizeActionsSettings } from '@/components/settings/actions/normalizeActionsSettings';
import { promptCollectionItemHref } from '@/components/settings/prompts/collection/promptCollectionModel';
import { isStaleSessionIntent, SessionIntentConflictLine } from '@/components/sessions/work/SessionIntentConflictLine';
import { WorkSection, WorkSectionBlock, WorkSectionEmptyLine } from '@/components/sessions/work/WorkSection';
import { Icon } from '@/components/ui/icons/Icon';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { usePageRowDensityOverride, usePageRowMetrics } from '@/components/ui/lists/useResolvedItemDensity';
import { PromptStackDocumentMenu } from '@/components/settings/prompts/stacks/PromptStackDocumentMenu';
import { Item } from '@/components/ui/lists/Item';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { isSessionAccessOwner } from '@/sync/engine/sessions/normalizeSessionAccessProjection';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { areServerProfileIdentifiersEquivalent, getServerProfileById } from '@/sync/domains/server/serverProfiles';
import {
  useActiveServerAccountScope,
  useSetting,
} from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import {
  sessionInstructionsActions,
  type SessionInstructionsTarget,
} from '@/sync/ops/promptLibrary/sessionInstructions';
import { t } from '@/text';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { InstructionsProvenanceLine } from './InstructionsProvenance';
import {
  resolveSessionInstructionsPolicy,
  useSessionInstructionsDetail,
  type SessionInstructionsAccess,
  type SessionInstructionsSource,
} from '../useSessionInstructionsSource';

/** The rendered document reads in this many body lines before "More" (lab `b-work A`). */
const COLLAPSED_LINES = 4;

type SaveState = 'idle' | 'pending';
/** Why a change didn't apply: this Account may not change it, or it didn't land for another reason. */
type Refusal = 'refused' | 'failed';
/**
 * A change the Session was no longer at the revision for (the metadata CAS refused a stale basis): the
 * document the person asked to attach, or null to detach. It is held, not lost, until they apply it to
 * the current revision or keep what the Session has.
 */
type HeldChange = Readonly<{ ref: PromptDocArtifactRefV1 | null }>;
const PERMISSION_REFUSALS: ReadonlySet<string> = new Set([
  'forbidden',
  'action_disabled',
  'permission_denied',
  'session_access_denied',
]);
const REFUSAL_COPY = {
  refused: 'sessionInstructions.refused',
  failed: 'sessionInstructions.setFailed',
} as const satisfies Record<Refusal, string>;

/** Who may read this Session's Instructions here: the owner, or nobody (shared viewers never see them). */
export function resolveSessionInstructionsAccess(
  session: Session | null,
): SessionInstructionsAccess {
  if (!session) return 'unavailable';
  if (!isSessionAccessOwner(session.access, session.accessLevel))
    return 'owner_private';
  return readSessionOwnerMetadataView(session) ? 'readable' : 'unavailable';
}

/** An Action outcome as the section reports it: applied, waiting for approval, or why it didn't apply. */
function readOutcome(
  result: ActionExecuteResult,
): 'applied' | 'pending' | 'conflict' | Refusal {
  if (!result.ok) {
    if (isStaleSessionIntent(result)) return 'conflict';
    return PERMISSION_REFUSALS.has(result.errorCode) ? 'refused' : 'failed';
  }
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
        key={JSON.stringify([serverId, session.id])}
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
  const execution = useMountedActionExecution(serverId);
  const homeName = resolveHomeDisplayLabel(getServerProfileById(serverId), serverId);
  const [saveState, setSaveState] = React.useState<SaveState>('idle');
  // A change that didn't apply says why in the section, where it was asked for, until the next attempt.
  const [refusal, setRefusal] = React.useState<Refusal | null>(null);
  const [held, setHeld] = React.useState<HeldChange | null>(null);
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

  // `change` is what a session write asked for, read after the run (Create learns its document then); only a
  // write that names one can meet a stale Session, so any other conflicting outcome is a plain failure.
  const settle = React.useCallback(
    async (run: () => Promise<ActionExecuteResult>, change?: () => HeldChange | null): Promise<boolean> => {
      setSaveState('pending');
      setRefusal(null);
      setHeld(null);
      try {
        const outcome = readOutcome(await run());
        const heldChange = outcome === 'conflict' ? change?.() ?? null : null;
        if (heldChange) setHeld(heldChange);
        else if (outcome === 'conflict') setRefusal('failed');
        else if (outcome !== 'applied' && outcome !== 'pending') setRefusal(outcome);
        // An approval request leaves the line saying it is waiting; the accepted write re-renders the section.
        if (outcome !== 'pending') setSaveState('idle');
        return outcome === 'applied';
      } catch {
        setSaveState('idle');
        setRefusal('failed');
        return false;
      }
    },
    [],
  );

  const attach = React.useCallback(
    (next: PromptDocArtifactRefV1) => {
      fireAndForget(
        settle(() => sessionInstructionsActions.set(target, next, undefined, execution.execute), () => ({ ref: next })),
        { tag: 'SessionInstructions.attach' },
      );
    },
    [execution.execute, settle, target],
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
            undefined,
            execution.execute,
          );
          created.ref = authored.createdRef;
          return authored.result;
        // The created document stays reusable: a stale attach holds it for the current revision.
        }, () => created.ref ? { ref: created.ref } : null);
        const opened = created.ref;
        if (applied && opened && execution.isCurrent())
          router.push(
            promptCollectionItemHref('doc', opened.artifactId, {
              serverId,
            }) as never,
          );
      })(),
      { tag: 'SessionInstructions.create' },
    );
  }, [execution.execute, execution.isCurrent, router, serverId, session, settle, target]);
  const detach = React.useCallback(() => {
    fireAndForget(
      settle(() => sessionInstructionsActions.set(target, null, undefined, execution.execute), () => ({ ref: null })),
      { tag: 'SessionInstructions.detach' },
    );
  }, [execution.execute, settle, target]);
  // Apply mine sends the held change again on the revision the Session has now (`target` is current).
  const applyHeld = React.useCallback(() => {
    if (!held) return;
    if (held.ref) attach(held.ref);
    else detach();
  }, [attach, detach, held]);

  const status = source.status;
  const repairable =
    status === 'not_found' || status === 'wrong_kind' || status === 'malformed';
  const showEdit = ref !== null && document !== null;
  // The Agent's last proposal for this document: waiting or not landed speaks at the top with the other
  // freshness lines; a settled one reads quietly with the provenance beneath the document.
  const agentWrite = source.writeFacts?.agentWriteResult?.status ?? null;
  const agentWriteAttention = agentWrite !== null && promptDocWriteNeedsAttention(agentWrite);
  return (
    <WorkSection
      testID="session-work-instructions"
      anatomy="page"
      title={t('sessionInstructions.title')}
      count=""
      icon="book-open"
      summary={document?.title ?? (status === 'none' ? t('common.add') : undefined)}
      nativeID="instructions"
      // Nothing to read yet: a closed "Add" row; it opens on Create · Attach existing.
      setupDefaultExpanded={status === 'none' ? false : undefined}
      loading={status === 'loading' || status === 'inactive'}
    >
      {saveState === 'pending' ? (
        <SurfaceFreshnessLine
          testID="session-work-instructions.pending"
          busy
          reason={t('sessionInstructions.savePending')}
        />
      ) : held ? (
        <SessionIntentConflictLine
          testID="session-work-instructions.conflict"
          subject={t('sessionInstructions.title')}
          current={document?.title}
          onApply={applyHeld}
          onKeep={() => setHeld(null)}
        />
      ) : refusal ? (
        <SurfaceFreshnessLine
          testID={`session-work-instructions.${refusal}`}
          tone="warning"
          reason={t(REFUSAL_COPY[refusal])}
        />
      ) : agentWrite !== null && agentWriteAttention ? (
        <SurfaceFreshnessLine
          testID={`session-work-instructions.agentWrite.${agentWrite}`}
          busy={agentWrite === 'pending'}
          tone={agentWrite === 'pending' ? 'neutral' : 'warning'}
          reason={t(PROMPT_DOC_WRITE_RESULT_KEY[agentWrite])}
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
        <>
          {document.markdown.trim().length > 0 ? (
            <ClampedInstructions markdown={document.markdown} />
          ) : (
            <WorkSectionEmptyLine
              testID="session-work-instructions.empty"
              text={t('sessionInstructions.empty')}
              onPress={edit}
            />
          )}
          {/* The footer: where it lives with its two quiet operations (lab csinfo I2), then what happened to it. */}
          <View style={styles.footer}>
            <WorkSectionBlock style={styles.sourceLine}>
              <Text
                style={[styles.meta, styles.sourceText, source.stale ? styles.metaStale : null]}
                numberOfLines={1}
              >
                {t('sessionInstructions.source', { title: document.title })}
              </Text>
              {showEdit ? (
                <>
                  <TextLinkButton
                    testID="session-work-instructions.edit"
                    label={t('sessionInstructions.edit')}
                    size="meta"
                    onPress={edit}
                  />
                  <TextLinkButton
                    testID="session-work-instructions.detach"
                    label={t('sessionInstructions.detach')}
                    size="meta"
                    onPress={detach}
                    disabled={saveState === 'pending'}
                  />
                </>
              ) : null}
            </WorkSectionBlock>
            {source.writeFacts ? (
              <WorkSectionBlock style={styles.provenance}>
                {agentWrite !== null && !agentWriteAttention ? (
                  <Text testID={`session-work-instructions.agentWrite.${agentWrite}`} style={[styles.meta, styles.result]}>
                    {t(PROMPT_DOC_WRITE_RESULT_KEY[agentWrite])}
                  </Text>
                ) : null}
                <InstructionsProvenanceLine
                  testID="session-work-instructions.provenance"
                  provenance={source.writeFacts.provenance}
                  serverId={serverId}
                  style={styles.meta}
                />
              </WorkSectionBlock>
            ) : null}
          </View>
        </>
      ) : status === 'none' ? (
        <WorkSectionBlock style={styles.invite}>
          <Text style={styles.inviteText}>{t('sessionInstructions.none')}</Text>
          <View style={[styles.actions, styles.inviteActions]}>
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
              quiet
              onAttach={attach}
            />
          </View>
        </WorkSectionBlock>
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
            // The cause is the title; what to do about it is the line beneath.
            subtitle={
              status === 'not_found'
                ? t('sessionInstructions.missingHelp')
                : undefined
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
      {document ? (
        <SessionInstructionsAgentEdits
          serverId={serverId}
          disabled={saveState === 'pending'}
          settle={settle}
        />
      ) : null}
    </WorkSection>
  );
});

/**
 * The rendered document, clamped to a few lines with More (lab `b-work A`). The clamp is measured,
 * not guessed: the body lays out at its natural height inside a clipped frame, and More appears only
 * when that height exceeds the clamp. The quiet line beneath names where it lives.
 */
function ClampedInstructions(
  props: Readonly<{ markdown: string }>,
) {
  const styles = stylesheet;
  // In an inspector (Session Info) the preview reads at the rows' own step; a Work page keeps its reading step.
  const inspector = usePageRowDensityOverride() === 'inspector';
  const rowMetrics = usePageRowMetrics();
  const textMetrics = inspector ? rowMetrics.title : happierPageTextMetrics('pageDescription');
  const lineHeight = textMetrics.lineHeight;
  const textStyle = React.useMemo(() => [styles.body, textMetrics], [styles.body, textMetrics]);
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
    <WorkSectionBlock style={styles.preview}>
      <View style={expanded ? null : [styles.clip, { maxHeight: clampHeight }]}>
        <View onLayout={onLayout}>
          <MarkdownView
            testID="session-work-instructions.body"
            markdown={props.markdown}
            textStyle={textStyle}
          />
        </View>
      </View>
      {overflows ? (
        <TextLinkButton
          testID="session-work-instructions.more"
          label={t('sessionInstructions.more')}
          expanded={false}
          onPress={() => setExpanded(true)}
        />
      ) : expanded ? (
        <TextLinkButton
          testID="session-work-instructions.less"
          label={t('sessionInstructions.less')}
          expanded
          onPress={() => setExpanded(false)}
        />
      ) : null}
    </WorkSectionBlock>
  );
}

/**
 * Agent edits: the real Ask first / Allowed control over the Account's `prompt_doc.update` setting for
 * the Agent surface, scoped in words to every Session on it. Only where this device holds that Account.
 */
function SessionInstructionsAgentEdits(props: Readonly<{
  serverId: string;
  disabled: boolean;
  settle: (run: () => Promise<ActionExecuteResult>) => Promise<boolean>;
}>) {
  const accountScope = useActiveServerAccountScope();
  const rawSettings = useSetting('actionsSettingsV1');
  const writeSetting = useSettingActionWriter({ serverId: props.serverId });
  const settings = React.useMemo(
    () => normalizeActionsSettings(rawSettings),
    [rawSettings],
  );
  const policy = React.useMemo(
    () =>
      resolveSessionInstructionsPolicy({
        settings,
        targetId: 'agent',
      }),
    [settings],
  );
  if (
    !accountScope ||
    !areServerProfileIdentifiersEquivalent(
      accountScope.serverId,
      props.serverId,
    )
  )
    return null;
  return (
    <Item
      testID="session-work-instructions.agentEdits"
      title={t('sessionInstructions.agentEdits')}
      subtitle={t('sessionInstructions.policyScope')}
      showChevron={false}
      // The Work pane is a narrow column on every device: the choice sits beneath its words, where they start.
      accessoryLayout="stacked"
      rightElement={
        <ActionSettingsTargetModeControl
          controlState={policy.controlState}
          accessibilityLabel={t('sessionInstructions.agentEdits')}
          testIDPrefix="session-work-instructions.agentEdits"
          layout="stacked"
          disabled={props.disabled}
          onChange={(value) => {
            if (value !== 'on') {
              fireAndForget(
                props.settle(() => writeSetting(ACTIONS_PROMPT_DOCUMENT_SETTINGS.settings.promptDocAgentEdits, value)),
                { tag: 'SessionInstructions.agentEdits' },
              );
            }
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
export function AttachExistingInstructions(
  props: Readonly<{
    serverId: string;
    title: string;
    testID?: string;
    /** Beside a primary way to start (Create instructions): the quiet second choice, not a second button. */
    quiet?: boolean;
    /** Written as words on a line (a New bot's Instructions line), not a button. */
    link?: boolean;
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
      {props.link ? (
        <TextLinkButton
          testID={props.testID ?? 'session-work-instructions.attach'}
          tone={props.quiet ? 'quiet' : 'strong'}
          label={props.title}
          expanded={open}
          onPress={() => setOpen(true)}
        />
      ) : (
        <RoundButton
          testID={props.testID ?? 'session-work-instructions.attach'}
          size="small"
          display={props.quiet ? 'inverted' : 'secondary'}
          title={props.title}
          onPress={() => setOpen(true)}
        />
      )}
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
    testID?: string;
    searchPlaceholder?: string;
  }>,
) {
  return (
    <PromptStackDocumentMenu
      testID={props.testID ?? 'session-work-instructions.attachMenu'}
      purpose="instructions"
      serverId={props.serverId}
      anchorRef={props.anchorRef}
      onClose={props.onClose}
      searchPlaceholder={
        props.searchPlaceholder ?? t('sessionInstructions.attachTitle')
      }
      onPick={(ref) => { if (ref.kind === 'doc') props.onAttach({ ...ref, kind: ref.kind }); }}
    />
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  // Text is not an `Item`: the block puts it on the rows' text edge.
  preview: {
    gap: theme.space.s6,
  },
  // Under the document: the source line with its operations, then (a step apart) what happened to it, and a
  // step of air before the next row so the three never read as one stack of equal lines.
  footer: {
    gap: theme.space.s8,
    paddingTop: theme.space.s6,
    paddingBottom: theme.space.s8,
  },
  sourceLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
  },
  // What happened to it: the result and its provenance are one tight pair, apart from the source line.
  provenance: {
    gap: theme.space.s2,
  },
  result: {
    color: theme.colors.text.secondary,
  },
  sourceText: {
    flex: 1,
    minWidth: 0,
  },
  clip: {
    overflow: 'hidden',
  },
  body: {
    ...Typography.default(),
    ...happierPageTextMetrics('pageDescription'),
    color: theme.colors.text.primary,
  },
  meta: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.tertiary,
  },
  metaStale: {
    color: theme.colors.state.warning.textForeground,
  },
  invite: {
    gap: theme.space.s10,
  },
  // Inside the invitation the buttons share its text edge.
  inviteActions: {
    paddingHorizontal: 0,
  },
  inviteText: {
    ...Typography.default(),
    ...happierPageTextMetrics('sectionDescription'),
    color: theme.colors.text.secondary,
  },
  repair: {
    gap: theme.space.s6,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: theme.space.s8,
    paddingHorizontal: HAPPIER_WORK_PANE_METRICS.rowInsetPx,
  },
}));
