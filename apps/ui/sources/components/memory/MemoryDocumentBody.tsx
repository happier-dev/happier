import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { MemoryScopeTargetV1 } from '@happier-dev/protocol/actions/executor/types';
import {
  MEMORY_ARCHIVE_TOPIC_TITLE_V1,
  type MemoryFactV1,
} from '@happier-dev/protocol/prompts/library/memoryDocV1';
import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { InlineAddExpander } from '@/components/ui/forms/InlineAddExpander';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { publishPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useSessionSelector } from '@/sync/domains/state/storage';
import {
  memoryDocumentActions,
  readMemoryActionOutcome,
  readMemoryCreationReceipt,
  type MemoryCreationReceipt,
  type MemorySessionTarget,
} from '@/sync/ops/promptLibrary/memoryDocuments';
import { getPreferredLanguage, t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { memoryDocumentHref } from './memoryDocumentRoutes';
import type { MemoryDocumentSource } from './useMemoryDocument';

/** A fact this fresh reads "Just now" rather than today's date. */
const JUST_NOW_MS = 60_000;

type Notice = 'pending' | 'conflict' | 'refused' | null;

export function formatMemoryDate(ms: number): string {
  return formatWithCachedDateTimeFormatter(ms, getPreferredLanguage(), {
    month: 'short',
    day: 'numeric',
  });
}

/** The topic's name as people read it; the reserved archive topic has a translated name. */
export function memoryTopicLabel(title: string): string {
  return title === MEMORY_ARCHIVE_TOPIC_TITLE_V1
    ? t('memoryContext.memory.archive')
    : title;
}

export type MemoryDocumentBodyProps = Readonly<{
  testID: string;
  source: MemoryDocumentSource;
  /** The Home the surface is about; names the document's Home when its reference does not. */
  serverId: string;
  /** Key facts shown before "Show all N"; omit on the document's own pages, which list every fact. */
  collapsedFactCount?: number;
  /** Who can see it and how agents may write to it, in words. */
  footer?: string;
  readOnly?: boolean;
  /** The section's "+" opens the remember form; the section header owns the button. */
  composing: boolean;
  onComposingChange: (open: boolean) => void;
  /** No document is attached yet: the first fact goes to the Session's own memory, which the host creates. */
  sessionTarget?: MemorySessionTarget | null;
  scopeTarget?: MemoryScopeTargetV1;
  onCreatedMemory?: (receipt: MemoryCreationReceipt) => void;
  emptyText: string;
  /**
   * How the host says "nothing remembered yet" in its own empty treatment (the Work pane's one quiet
   * line). Omitted, the document's pages draw it as an information row.
   */
  renderEmpty?: (line: Readonly<{ testID: string; text: string }>) => React.ReactNode;
  /** Opens the Session a fact came from, through the host's Session navigation owner. */
  onOpenSession?: (ref: Readonly<{ serverId: string; sessionId: string }>) => void;
}>;

/**
 * The one renderer of a `memory_doc.v1` document (lab `c-mem`, `c-ctx`; D48): the summary line, the
 * index's key facts as one-line rows, then its topics (title + one-line summary) which open their own
 * page, and the access line. Work › Memory, Settings › Context and Project › Context all draw their
 * memory with it, and the document's own pages reuse it with every fact listed. Remember, edit and
 * forget are the public `memory.*` Actions against the version on screen; a conflict shows the
 * current version and keeps what was typed.
 */
export const MemoryDocumentBody = React.memo(function MemoryDocumentBody(
  props: MemoryDocumentBodyProps,
) {
  const styles = stylesheet;
  const { source, serverId, testID, onComposingChange, onCreatedMemory } = props;
  const router = useRouter();
  const view = source.view;
  const target = source.target;
  const topic = view?.topic ?? null;
  const archive = topic?.title === MEMORY_ARCHIVE_TOPIC_TITLE_V1;
  const writable = !props.readOnly && !archive;
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<Notice>(null);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState('');
  const [draftTopic, setDraftTopic] = React.useState('');
  const draftRef = React.useRef<React.ElementRef<typeof FieldTextInput>>(null);

  const refresh = source.refresh;
  const settle = React.useCallback(
    async (run: () => Promise<ActionExecuteResult>): Promise<boolean> => {
      setBusy(true);
      setNotice(null);
      try {
        const result = await run();
        const outcome = readMemoryActionOutcome(result);
        const receipt = readMemoryCreationReceipt(result);
        // A refusal is said in place, beside what it did not change, until the next attempt.
        if (outcome === 'pending' || outcome === 'conflict' || outcome === 'refused') setNotice(outcome);
        // An attachment conflict still saved this fact. Keep the exact document reachable,
        // and close its draft so retrying cannot create a second copy of that fact.
        if (receipt) onCreatedMemory?.(receipt);
        // A conflict hands back the current version; show it and keep what was typed.
        if (outcome !== 'refused') await refresh();
        return outcome === 'applied' || receipt !== null;
      } catch {
        setNotice('refused');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [onCreatedMemory, refresh],
  );

  const closeDraft = React.useCallback(() => {
    setEditingId(null);
    setDraft('');
    setDraftTopic('');
    onComposingChange(false);
  }, [onComposingChange]);

  const sessionTarget = props.sessionTarget ?? null;
  const scopeTarget = props.scopeTarget;
  const canCreate = source.status === 'none' && view === null && Boolean(scopeTarget || sessionTarget);
  const save = React.useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    const named = draftTopic.trim();
    const fallback = sessionTarget;
    if (!target && !canCreate) return;
    fireAndForget(
      (async () => {
        const applied = await settle(() => {
          if (editingId && target)
            return memoryDocumentActions.update(target, {
              factId: editingId,
              text,
            });
          if (target) {
            return memoryDocumentActions.remember(
              topic || !named ? target : { ...target, topic: named },
              { text },
            );
          }
          if (scopeTarget)
            return memoryDocumentActions.rememberInScope(scopeTarget, {
              text,
              ...(named ? { topic: named } : {}),
            }, serverId);
          if (!fallback) throw new Error('memory_target_unavailable');
          return memoryDocumentActions.rememberInSession(fallback, {
            text,
            ...(named ? { topic: named } : {}),
          });
        });
        if (applied) closeDraft();
      })(),
      { tag: 'MemoryDocumentBody.save' },
    );
  }, [
    closeDraft,
    draft,
    draftTopic,
    editingId,
    canCreate,
    scopeTarget,
    serverId,
    sessionTarget,
    settle,
    target,
    topic,
  ]);

  const forget = React.useCallback(
    (fact: MemoryFactV1) => {
      if (!target) return;
      fireAndForget(
        (async () => {
          const applied = await settle(() =>
            memoryDocumentActions.forget(target, fact.id),
          );
          if (!applied) return;
          // The fact is already in the archive topic; Undo is offered on the app's one notice owner
          // (its lifetime, its place) and restores this exact fact to where it was.
          const key = `memory-forget:${fact.id}`;
          const restoreTopic = topic?.title;
          publishPresentationNotice({
            key,
            severity: 'info',
            message: t('memoryContext.memory.forgot'),
            undo: {
              label: t('memoryContext.memory.undo'),
              run: () => {
                retirePresentationNotice(key);
                fireAndForget(
                  settle(() => memoryDocumentActions.restore(target, fact.id, restoreTopic)),
                  { tag: 'MemoryDocumentBody.undoForget' },
                );
              },
            },
          });
        })(),
        { tag: 'MemoryDocumentBody.forget' },
      );
    },
    [settle, target, topic],
  );

  const startEdit = React.useCallback(
    (fact: MemoryFactV1) => {
      onComposingChange(false);
      setEditingId(fact.id);
      setDraft(fact.text);
    },
    [onComposingChange],
  );

  const openTopic = React.useCallback(
    (title: string) => {
      if (!view) return;
      router.push(
        memoryDocumentHref(view.ref, { topic: title }) as never,
      );
    },
    [router, view],
  );
  const openAll = React.useCallback(() => {
    if (!view) return;
    router.push(
      memoryDocumentHref(view.ref) as never,
    );
  }, [router, view]);

  const status = source.status;
  const facts = view?.facts ?? [];
  const limit = props.collapsedFactCount;
  const shown =
    limit === undefined || facts.length <= limit
      ? facts
      : facts.slice(0, limit);
  const hiddenCount = facts.length - shown.length;
  const topics = view?.topics ?? [];
  const draftForm = (
    <InlineAddExpander
      isOpen
      onOpenChange={() => {}}
      trigger={null}
      title={t('memoryContext.memory.remember')}
      onCancel={closeDraft}
      onSave={save}
      saveDisabled={busy || draft.trim().length === 0}
      cancelLabel={t('common.cancel')}
      saveLabel={
        editingId ? t('common.save') : t('memoryContext.memory.rememberSave')
      }
      autoFocusRef={draftRef}
      saveTestID={`${testID}.draft.save`}
      cancelTestID={`${testID}.draft.cancel`}
    >
      <FieldTextInput
        ref={draftRef}
        testID={`${testID}.draft`}
        value={draft}
        onChangeText={setDraft}
        accessibilityLabel={t('memoryContext.memory.remember')}
        placeholder={t('memoryContext.memory.rememberPlaceholder')}
        multiline
        minLines={2}
      />
      {!editingId && !topic ? (
        <FieldTextInput
          testID={`${testID}.draftTopic`}
          style={styles.topicField}
          value={draftTopic}
          onChangeText={setDraftTopic}
          accessibilityLabel={t('memoryContext.memory.topicPlaceholder')}
          placeholder={t('memoryContext.memory.topicPlaceholder')}
          onSubmitEditing={save}
        />
      ) : null}
    </InlineAddExpander>
  );

  return (
    <>
      {notice === 'pending' ? (
        <SurfaceFreshnessLine
          testID={`${testID}.pending`}
          busy
          reason={t('memoryContext.memory.pending')}
        />
      ) : notice === 'conflict' ? (
        <SurfaceFreshnessLine
          testID={`${testID}.conflict`}
          tone="warning"
          reason={t('memoryContext.memory.conflict')}
        />
      ) : notice === 'refused' ? (
        <SurfaceFreshnessLine
          testID={`${testID}.refused`}
          tone="warning"
          reason={t('memoryContext.memory.refused')}
        />
      ) : status === 'unavailable' ? (
        <SurfaceFreshnessLine
          testID={`${testID}.unavailable`}
          tone="warning"
          reason={
            view
              ? t('memoryContext.memory.offlineStale')
              : t('memoryContext.memory.offline')
          }
          action={{
            label: t('common.retry'),
            onPress: () => {
              fireAndForget(refresh(), { tag: 'MemoryDocumentBody.retry' });
            },
          }}
        />
      ) : null}
      {view ? (
        <Item
          testID={`${testID}.summary`}
          mode="info"
          density="compact"
          showChevron={false}
          showDivider={false}
          title={
            <Text style={styles.summary}>
              {topic ? null : `${t('memoryContext.memory.alwaysRemembered')} `}
              <Text style={styles.summaryValue}>
                {t('memoryContext.memory.factCount', { count: facts.length })}
              </Text>
              {topics.length > 0 ? (
                <>
                  {` · ${t('memoryContext.memory.topicsLabel')} `}
                  <Text style={styles.summaryValue}>
                    {String(topics.length)}
                  </Text>
                </>
              ) : null}
            </Text>
          }
        />
      ) : null}
      {props.composing && !editingId && writable && (target || canCreate) ? draftForm : null}
      {shown.map((fact) =>
        editingId === fact.id ? (
          <React.Fragment key={fact.id}>{draftForm}</React.Fragment>
        ) : (
          <MemoryFactRow
            key={fact.id}
            testID={`${testID}.fact.${fact.id}`}
            fact={fact}
            serverId={serverId}
            archived={archive}
            writable={writable && target !== null}
            disabled={busy}
            onEdit={startEdit}
            onForget={forget}
            onOpenSession={props.onOpenSession}
          />
        ),
      )}
      {hiddenCount > 0 ? (
        <Item
          testID={`${testID}.showAll`}
          density="compact"
          showChevron={false}
          showDivider={false}
          title={t('memoryContext.memory.showAll', { count: facts.length })}
          titleStyle={styles.showAll}
          onPress={openAll}
        />
      ) : null}
      {view && facts.length === 0 && !props.composing ? (
        props.renderEmpty ? props.renderEmpty({
          testID: `${testID}.empty`,
          text: topic ? t('memoryContext.memory.topicEmpty') : props.emptyText,
        }) : <Item
          testID={`${testID}.empty`}
          mode="info"
          showChevron={false}
          showDivider={topics.length > 0}
          title={topic ? t('memoryContext.memory.topicEmpty') : props.emptyText}
          titleStyle={styles.empty}
        />
      ) : null}
      {topics.map((entry) => (
        <Item
          key={entry.title}
          testID={`${testID}.topic.${entry.title}`}
          // No leading glyph: facts and topics share one text edge, and the chevron says a topic opens.
          title={memoryTopicLabel(entry.title)}
          subtitle={
            entry.title === MEMORY_ARCHIVE_TOPIC_TITLE_V1
              ? t('memoryContext.memory.archiveSummary')
              : entry.summary
          }
          subtitleLines={1}
          onPress={() => openTopic(entry.title)}
        />
      ))}
      {!view && status === 'none' ? (
        props.composing && writable && canCreate ? null : props.renderEmpty ? props.renderEmpty({ testID: `${testID}.none`, text: props.emptyText }) : (
          <Item
            testID={`${testID}.none`}
            mode="info"
            showChevron={false}
            showDivider={false}
            title={props.emptyText}
            titleStyle={styles.empty}
          />
        )
      ) : !view &&
        (status === 'not_found' ||
          status === 'invalid' ||
          status === 'locked') ? (
        <Item
          testID={`${testID}.${status}`}
          icon={<Icon name={status === 'locked' ? 'lock' : 'warning'} />}
          showChevron={false}
          showDivider={false}
          title={
            status === 'locked'
              ? t('memoryContext.memory.locked')
              : status === 'not_found'
                ? t('memoryContext.memory.missing')
                : t('memoryContext.memory.invalid')
          }
        />
      ) : null}
      {view && props.footer ? (
        <Item
          testID={`${testID}.footer`}
          mode="info"
          density="compact"
          showChevron={false}
          showDivider={false}
          title={props.footer}
          titleLines={2}
          titleStyle={styles.footer}
        />
      ) : null}
    </>
  );
});

/**
 * One remembered fact: the fact (two lines at most in a list), then one quiet line of date, expiry and
 * the Session it came from. "⋯" holds Edit, Forget and Open source; an archived fact is read-only.
 */
const MemoryFactRow = React.memo(function MemoryFactRow(
  props: Readonly<{
    testID: string;
    fact: MemoryFactV1;
    serverId: string;
    archived: boolean;
    writable: boolean;
    disabled: boolean;
    onEdit: (fact: MemoryFactV1) => void;
    onForget: (fact: MemoryFactV1) => void;
    onOpenSession?: (
      ref: Readonly<{ serverId: string; sessionId: string }>,
    ) => void;
  }>,
) {
  const styles = stylesheet;
  const { fact, onEdit, onForget, onOpenSession } = props;
  const source = fact.sourceSessionRef;
  // Row-local: only this fact's source Session title, and only when that Session is loaded here.
  const sourceName = useSessionSelector(
    source?.sessionId ?? '',
    source?.serverId ?? props.serverId,
    (session) =>
      session && source ? getSessionName(session, source.serverId) : null,
  );
  const now = Date.now();
  const expired = fact.expiresAtMs !== undefined && fact.expiresAtMs <= now;
  const facts = [
    now - fact.createdAtMs < JUST_NOW_MS
      ? t('memoryContext.memory.justNow')
      : formatMemoryDate(fact.createdAtMs),
    fact.expiresAtMs === undefined
      ? null
      : expired
        ? t('memoryContext.memory.expired', {
            date: formatMemoryDate(fact.expiresAtMs),
          })
        : t('memoryContext.memory.until', {
            date: formatMemoryDate(fact.expiresAtMs),
          }),
    source ? null : t('memoryContext.memory.addedByYou'),
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
  // The Session a fact came from is a link at the end of its line (lab `c-mem`), when this client
  // can name it and the host can open it; otherwise its name is plain text.
  const sourceLink = source && sourceName && onOpenSession ? () => onOpenSession(source) : null;
  const meta = sourceLink || !sourceName ? facts : `${facts} · ${sourceName}`;
  const actions = React.useMemo((): ItemAction[] => {
    const list: ItemAction[] = [];
    if (props.writable) {
      list.push({
        id: 'edit',
        title: t('common.edit'),
        icon: 'pencil',
        disabled: props.disabled,
        onPress: () => onEdit(fact),
      });
    }
    if (props.writable) {
      list.push({
        id: 'forget',
        title: t('memoryContext.memory.forget'),
        icon: 'trash',
        destructive: true,
        disabled: props.disabled,
        onPress: () => onForget(fact),
      });
    }
    return list;
  }, [fact, onEdit, onForget, props.disabled, props.writable]);
  return (
    <Item
      testID={props.testID}
      mode="info"
      title={fact.text}
      titleLines={props.archived ? undefined : 2}
      titleStyle={props.archived || expired ? styles.retired : undefined}
      subtitle={sourceLink && sourceName ? (
        <Text numberOfLines={1} style={styles.factMeta}>
          {`${meta} · `}
          <Text
            testID={`${props.testID}.source`}
            accessibilityRole="link"
            accessibilityLabel={t('memoryContext.memory.openSource')}
            style={styles.factSource}
            onPress={sourceLink}
          >
            {sourceName}
          </Text>
        </Text>
      ) : meta}
      subtitleLines={1}
      showChevron={false}
      rightElement={
        actions.length > 0 ? (
          <ItemRowActions
            title={fact.text}
            actions={actions}
            overflowOnly
            overflowTriggerTestID={`${props.testID}.more`}
          />
        ) : undefined
      }
    />
  );
});

const stylesheet = StyleSheet.create((theme) => ({
  summary: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  summaryValue: {
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
  },
  showAll: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
  },
  empty: {
    ...Typography.default(),
    ...happierPageTextMetrics('pageDescription'),
    color: theme.colors.text.secondary,
  },
  footer: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.tertiary,
  },
  retired: {
    color: theme.colors.text.tertiary,
    textDecorationLine: 'line-through',
  },
  factMeta: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.tertiary,
    fontVariant: ['tabular-nums'],
  },
  factSource: {
    color: theme.colors.text.secondary,
  },
  topicField: {
    marginTop: 8,
  },
}));
