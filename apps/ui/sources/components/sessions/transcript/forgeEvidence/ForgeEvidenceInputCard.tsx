import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { SessionInputForgeEvidenceV1 } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';

import { SurfaceCard } from '@/components/ui/cards/SurfaceCard';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { DisclosureCaret } from '@/components/ui/lists/DisclosureCaret';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useOpenResource } from '@/utils/url/openResource';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

type Item = SessionInputForgeEvidenceV1['items'][number];
type SourceKind = Item['source']['kind'];

const SOURCE_GLYPH: Readonly<Record<SourceKind, IconName>> = {
  pullRequest: 'git-pull-request',
  hostedCi: 'play-circle',
  releaseNotes: 'tag',
  alert: 'shield',
  localTerminal: 'terminal',
  entry: 'link',
};

function sourceKindLabel(kind: SourceKind): string {
  switch (kind) {
    case 'pullRequest':
      return t('message.forgeEvidence.kind.pullRequest');
    case 'hostedCi':
      return t('message.forgeEvidence.kind.hostedCi');
    case 'releaseNotes':
      return t('message.forgeEvidence.kind.releaseNotes');
    case 'alert':
      return t('message.forgeEvidence.kind.alert');
    case 'localTerminal':
      return t('message.forgeEvidence.kind.localTerminal');
    case 'entry':
      return t('message.forgeEvidence.kind.entry');
  }
}

function authorLabel(author: Item['author']): string {
  if (author.label) return author.label;
  switch (author.kind) {
    case 'person':
      return t('message.forgeEvidence.author.person');
    case 'bot':
      return t('message.forgeEvidence.author.bot');
    case 'process':
      return t('message.forgeEvidence.author.process');
    case 'unknown':
      return t('message.forgeEvidence.author.unknown');
  }
}

/** Machine-shaped evidence (a JSON record) is shown as code behind a disclosure, never as prose. */
function isStructuredText(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

const EvidenceItem = React.memo(function EvidenceItem(
  props: Readonly<{ item: Item; index: number; testID: string }>,
) {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const { item } = props;
  const structured = isStructuredText(item.text);
  const [firstLine, ...rest] = structured ? [''] : item.text.split('\n');
  const remainder = rest.join('\n').trim();
  return (
    <View style={styles.item} testID={`${props.testID}.item.${props.index}`}>
      <Text style={styles.author} numberOfLines={1}>
        {authorLabel(item.author)}
      </Text>
      {structured ? null : (
        <Text selectable style={styles.headline}>
          {firstLine}
        </Text>
      )}
      {!structured && remainder.length > 0 ? (
        <Text selectable style={styles.body}>
          {remainder}
        </Text>
      ) : null}
      {structured ? (
        <>
          <HappierPressable
            accessibilityRole="button"
            expanded={open}
            onPress={() => setOpen((value) => !value)}
            style={styles.disclosure}
            testID={`${props.testID}.item.${props.index}.evidence`}
          >
            <DisclosureCaret expanded={open} size={12} />
            <Text style={styles.disclosureLabel}>
              {open
                ? t('message.forgeEvidence.hideEvidence')
                : t('message.forgeEvidence.showEvidence')}
            </Text>
          </HappierPressable>
          {open ? (
            <MarkdownView
              markdown={`\`\`\`json\n${prettyJson(item.text)}\n\`\`\``}
              selectable
              profile="transcript"
            />
          ) : null}
        </>
      ) : null}
    </View>
  );
});

/**
 * An input that delivered outside evidence to the agent (lab forge-ci c3: a PR update, a CI failure): what it is,
 * where it came from, who wrote it and the evidence itself, as data. It reads only the structured
 * `SessionInputForgeEvidenceV1` carried in the message's metadata (decision D-I12), never the rendered prompt, and the
 * evidence grants nothing.
 */
export const ForgeEvidenceInputCard = React.memo(
  function ForgeEvidenceInputCard(
    props: Readonly<{
      evidence: SessionInputForgeEvidenceV1;
      testID: string;
      sessionId?: string;
      serverId?: string | null;
    }>,
  ) {
    const { theme } = useUnistyles();
    const { openResourceUrl } = useOpenResource({ sessionId: props.sessionId, serverId: props.serverId ?? undefined });
    const first = props.evidence.items[0]!;
    const sources = new Set(
      props.evidence.items.map(
        (item) => `${item.source.kind}:${item.source.label}`,
      ),
    );
    const url = first.source.url;
    return (
      <SurfaceCard padding="sm" testID={props.testID}>
        <View style={styles.header}>
          <Icon
            name={SOURCE_GLYPH[first.source.kind]}
            size={16}
            color={theme.colors.text.secondary}
          />
          <Text style={styles.kind}>{sourceKindLabel(first.source.kind)}</Text>
          {url ? (
            <HappierPressable
              accessibilityRole="link"
              onPress={() => {
                void openResourceUrl(url);
              }}
              style={styles.sourcePress}
            >
              <Text style={styles.sourceLink} numberOfLines={1}>
                {first.source.label}
              </Text>
            </HappierPressable>
          ) : (
            <Text style={styles.source} numberOfLines={1}>
              {first.source.label}
            </Text>
          )}
          {sources.size > 1 ? (
            <Text style={styles.source}>
              {t('message.forgeEvidence.moreSources', {
                count: sources.size - 1,
              })}
            </Text>
          ) : null}
        </View>
        <View style={styles.items}>
          {props.evidence.items.map((item, index) => (
            <EvidenceItem
              key={index}
              item={item}
              index={index}
              testID={props.testID}
            />
          ))}
        </View>
      </SurfaceCard>
    );
  },
);

const styles = StyleSheet.create((theme) => ({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    minWidth: 0,
  },
  kind: {
    ...Typography.variant('label', 'semiBold'),
    color: theme.colors.text.primary,
  },
  sourcePress: { flexShrink: 1, minWidth: 0 },
  sourceLink: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
    textDecorationLine: 'underline',
  },
  source: {
    flexShrink: 1,
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
  items: { gap: theme.space.s12, marginTop: theme.space.s10 },
  item: { gap: theme.space.s4 },
  author: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
  headline: {
    ...Typography.variant('label', 'medium'),
    color: theme.colors.text.primary,
  },
  body: { ...Typography.variant('body'), color: theme.colors.text.secondary },
  disclosure: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
    alignSelf: 'flex-start',
  },
  disclosureLabel: {
    ...Typography.variant('meta', 'medium'),
    color: theme.colors.text.secondary,
  },
}));
