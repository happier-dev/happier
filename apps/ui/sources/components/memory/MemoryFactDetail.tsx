import {
  MEMORY_ARCHIVE_TOPIC_TITLE_V1,
  renderMemoryDocV1,
  type MemoryFactV1,
} from '@happier-dev/protocol/prompts/library/memoryDocV1';
import type { PromptDocArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';
import type { DiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { formatMemoryDate, useMemoryFactAttribution } from './useMemoryFactAttribution';
import { useMemoryDocument } from './useMemoryDocument';
import { useMemoryFactSource } from './useMemoryFactSource';

/**
 * One remembered fact on its own (lab K2 `A` detail, `Dp`): the fact as the title, then what makes it
 * trustworthy — the reason and the Session it was decided in, who approved it (or that no person did),
 * when it was saved and when it expires — then the exact line agents load, and its history (the facts
 * it replaced, read from the document's archive). The desktop list shows it beside the facts; a phone
 * pushes it.
 */
export const MemoryFactDetail = React.memo(function MemoryFactDetail(
  props: Readonly<{
    testID: string;
    fact: MemoryFactV1;
    documentRef: PromptDocArtifactRefV1 | null;
    serverId: string | null;
    /** The Account reading the document, so its own approval reads "You". */
    viewerAccountId: string | null;
    /** The fact sits in the archive: it is history already and agents never load it. */
    archived: boolean;
    onOpenSession?: (
      ref: Readonly<{ serverId: string; sessionId: string; messageId?: string }>,
    ) => void;
    onOpenDiscussion?: (ref: DiscussionMessageRefV1) => void;
    /** Present when this reader may change the fact: its edit form opens in the list. */
    onEdit?: () => void;
  }>,
) {
  const { fact, onOpenSession, onOpenDiscussion } = props;
  const decision = fact.decision;
  const { source, title: sourceName } = useMemoryFactSource(fact);
  // Only a fact that replaced another reads the archive, where the replaced facts keep their words.
  const archive = useMemoryDocument({
    ref:
      fact.supersedes !== undefined && !props.archived
        ? props.documentRef
        : null,
    serverId: props.serverId,
    topic: MEMORY_ARCHIVE_TOPIC_TITLE_V1,
  });
  const replaced = React.useMemo(() => {
    const byId = new Map(
      (archive.view?.facts ?? []).map((entry) => [entry.id, entry]),
    );
    const chain: MemoryFactV1[] = [];
    let next = fact.supersedes;
    while (
      next !== undefined &&
      byId.has(next) &&
      !chain.some((entry) => entry.id === next)
    ) {
      const entry = byId.get(next)!;
      chain.push(entry);
      next = entry.supersedes;
    }
    return chain;
  }, [archive.view?.facts, fact.supersedes]);
  const now = Date.now();
  const expired = fact.expiresAtMs !== undefined && fact.expiresAtMs <= now;
  // The exact line agents load, from the same renderer that prepares their context.
  const agentLine = props.archived
    ? ''
    : renderMemoryDocV1({ body: { v: 1, index: [fact], topics: [] }, nowMs: now }).markdown.trim();
  const agentEntry = React.useMemo(() => readAgentLine(agentLine), [agentLine]);
  const [exactLine, setExactLine] = React.useState(false);
  const attribution = useMemoryFactAttribution(fact, props.documentRef?.serverId ?? props.serverId);
  const expiry =
    fact.expiresAtMs === undefined
      ? t('memoryContext.memory.sheetExpiresNever')
      : expired
        ? t('memoryContext.memory.detailExpired', {
            date: formatMemoryDate(fact.expiresAtMs),
          })
        : formatMemoryDate(fact.expiresAtMs);
  const openSource = source?.kind === 'session' && onOpenSession
    ? () => onOpenSession({ ...source.session, ...(source.messageId ? { messageId: source.messageId } : {}) })
    : source?.kind === 'discussion' && onOpenDiscussion
      ? () => onOpenDiscussion(source)
      : undefined;
  const sourceLabel = sourceName || (source?.kind === 'discussion'
    ? t('session.collaboration.discussion.secondOpinion.open') : t('memoryContext.memory.openSource'));
  return (
    <ItemList testID={props.testID}>
      <PageHeader
        title={fact.text}
        actions={props.onEdit ? (
          <RoundButton
            testID={`${props.testID}.edit`}
            display="secondary"
            title={t('common.edit')}
            onPress={props.onEdit}
          />
        ) : undefined}
        actionsPlacement="page"
        meta={[
          {
            key: 'kind',
            icon: decision ? 'check-circle' : 'note',
            text: decision
              ? t('memoryContext.memory.decision')
              : t('memoryContext.memory.note'),
            testID: `${props.testID}.kind`,
          },
        ]}
      />
      <ItemGroup>
        {decision ? (
          <Item
            testID={`${props.testID}.reason`}
            mode="info"
            title={t('memoryContext.memory.sheetReasonLabel')}
            accessoryLayout="adaptive"
            rightElement={
              <Text variant="body" style={styles.value}>
                {decision.reason}
              </Text>
            }
            showChevron={false}
          />
        ) : null}
        {source ? (
          <Item
            testID={`${props.testID}.source`}
            title={
              decision
                ? t('memoryContext.memory.detailDecidedIn')
                : t('memoryContext.memory.detailCameFrom')
            }
            detail={sourceLabel}
            onPress={openSource}
            mode={openSource ? 'interactive' : 'info'}
            showChevron={Boolean(openSource)}
          />
        ) : null}
        {decision ? (
          <Item
            testID={`${props.testID}.approval`}
            mode="info"
            title={t('memoryContext.memory.detailApprovedBy')}
            detail={attribution.detailApproval ?? undefined}
            showChevron={false}
          />
        ) : null}
        <Item
          testID={`${props.testID}.saved`}
          mode="info"
          title={t('memoryContext.memory.detailSaved')}
          detail={attribution.savedLabel}
          showChevron={false}
        />
        <Item
          testID={`${props.testID}.expires`}
          mode="info"
          title={t('memoryContext.memory.sheetExpires')}
          detail={expiry}
          showChevron={false}
          showDivider={false}
        />
      </ItemGroup>
      <ItemGroup
        title={t('memoryContext.memory.whatAgentsSee')}
        actionLayout="trailing"
        action={agentLine && agentEntry ? (
          <Pressable
            testID={`${props.testID}.exactLine`}
            accessibilityRole="button"
            accessibilityState={{ expanded: exactLine }}
            hitSlop={8}
            onPress={() => setExactLine((open) => !open)}
          >
            <Text style={styles.toggle}>
              {exactLine ? t('memoryContext.memory.readableLine') : t('memoryContext.memory.exactLine')}
            </Text>
          </Pressable>
        ) : undefined}
        description={
          agentLine
            ? t('memoryContext.memory.whatAgentsSeeLoaded')
            : t('memoryContext.memory.whatAgentsSeeNotLoaded')
        }
      >
        {agentLine ? (
          <View testID={`${props.testID}.agentLine`} style={styles.agentLine}>
            {exactLine || !agentEntry ? (
              <Text selectable style={styles.agentLineText}>
                {agentLine}
              </Text>
            ) : (
              <>
                <Text selectable variant="body" style={styles.value}>{agentEntry.text}</Text>
                {agentEntry.facts.length > 0 ? (
                  <Text style={styles.agentLineMeta}>{agentEntry.facts.join(' · ')}</Text>
                ) : null}
              </>
            )}
          </View>
        ) : null}
      </ItemGroup>
      {replaced.length > 0 ? (
        <ItemGroup title={t('memoryContext.memory.historyTitle')}>
          {replaced.map((entry, index) => (
            <Item
              key={entry.id}
              testID={`${props.testID}.history.${entry.id}`}
              mode="info"
              title={entry.text}
              titleLines={0}
              titleStyle={styles.replaced}
              subtitle={[
                t('memoryContext.memory.historyReplaced', {
                  date: formatMemoryDate(
                    (index === 0 ? fact : replaced[index - 1]!).createdAtMs,
                  ),
                }),
                entry.decision?.reason,
              ]
                .filter(Boolean)
                .join(' · ')}
              subtitleLines={2}
              showChevron={false}
              showDivider={index < replaced.length - 1}
            />
          ))}
        </ItemGroup>
      ) : null}
    </ItemList>
  );
});

/**
 * The index line agents load, read back for people: its words, then the facts it carries in plain
 * terms ("added Oct 19", "expires …"). The id stays in the exact line. Null when the line is not the
 * renderer's `- text [k: v; …]` shape, so the exact line is shown instead.
 */
function readAgentLine(line: string): Readonly<{ text: string; facts: readonly string[] }> | null {
  const match = /^- (.*) \[([^\]]*)\]$/.exec(line);
  if (!match) return null;
  const facts: string[] = [];
  for (const part of match[2]!.split('; ')) {
    const separator = part.indexOf(': ');
    if (separator < 0) continue;
    const key = part.slice(0, separator);
    const value = part.slice(separator + 2);
    if (key === 'added') facts.push(t('memoryContext.memory.agentLineAdded', { date: formatAgentLineDate(value) }));
    else if (key === 'expires') facts.push(t('memoryContext.memory.agentLineExpires', { date: formatAgentLineDate(value) }));
    else if (key === 'source') facts.push(t('memoryContext.memory.agentLineSource'));
    else if (key === 'supersedes') facts.push(t('memoryContext.memory.agentLineReplaces'));
  }
  return { text: match[1]!, facts };
}

/** The line's dates are whole days (`YYYY-MM-DD`); people read them the way the rest of Memory does. */
function formatAgentLineDate(value: string): string {
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) ? value : formatMemoryDate(ms);
}

const styles = StyleSheet.create((theme) => ({
  agentLineMeta: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
    marginTop: theme.space.s4,
  },
  toggle: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
  },
  value: {
    color: theme.colors.text.primary,
  },
  agentLine: {
    // The group's own sheet is the frame; the line sits in it as the agents read it.
    paddingVertical: theme.space.s12,
    paddingHorizontal: theme.space.s16,
  },

  agentLineText: {
    ...Typography.mono(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
  },
  replaced: {
    color: theme.colors.text.tertiary,
    textDecorationLine: 'line-through',
  },
}));
