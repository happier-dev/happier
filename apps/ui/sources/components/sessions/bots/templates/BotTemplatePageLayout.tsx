import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
import type { BotTemplateContentV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { PageAsideColumns } from '@/components/ui/layout/PageAsideColumns';
import { ItemList } from '@/components/ui/lists/ItemList';
import { KeyboardStickyFooter } from '@/components/ui/keyboardAvoidance/KeyboardStickyFooter';
import { PagePinnedBar } from '@/components/ui/layout/PagePinnedBar';
import { PageFrame } from '@/components/ui/layout/PageFrame';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { Icon } from '@/components/ui/icons/Icon';
import type { IconName } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { SessionBotFace } from '@/components/sessions/bots/face/SessionBotFace';
import { useDeviceType } from '@/utils/platform/responsive';
import { t } from '@/text';

/** The aside's identity face: the row mark size the receipt asides use. */
const ASIDE_FACE_SIZE = 36;

/**
 * A template's own page (preview, setup): the R10 header, then the sections beside "What you get",
 * which stays in view while they scroll; a phone reads the sections first and the summary after.
 */
export function BotTemplatePageLayout(
  props: Readonly<{
    header: React.ReactNode;
    notice?: React.ReactNode;
    content: BotTemplateContentV1;
    children: React.ReactNode;
    /**
     * The page's primary step, pinned under the scroll (setup's Create, a phone preview's Make my own):
     * beside its note on wide layouts, full width beneath it on a phone.
     */
    footer?: React.ReactNode;
    /** What the primary step will do, or why it cannot yet. */
    footerNote?: React.ReactNode;
    testID?: string;
  }>,
) {
  const compact = useDeviceType() === 'phone';
  const list = (
    <ItemList keyboardAware pageColumn="wide" testID={props.testID}>
      {props.header}
      {props.notice}
      <PageAsideColumns
        compact={compact}
        aside={<BotTemplateWhatYouGet content={props.content} />}
      >
        {props.children}
      </PageAsideColumns>
    </ItemList>
  );
  if (!props.footer) return list;
  return (
    <View style={styles.page}>
      {list}
      <BotTemplatePinnedFooter note={props.footerNote} column="wide">{props.footer}</BotTemplatePinnedFooter>
    </View>
  );
}

/**
 * A template page's pinned step (setup's Create, the update review's Update): what it will do on the
 * left, the actions on the right, aligned to the page's column; a phone stacks them full width.
 */
export function BotTemplatePinnedFooter(
  props: Readonly<{ note?: React.ReactNode; column: 'wide' | 'reading'; children: React.ReactNode }>,
) {
  const compact = useDeviceType() === 'phone';
  return (
    <KeyboardStickyFooter>
      <PagePinnedBar>
        {compact ? (
          <View style={styles.footerStacked}>
            {props.note ? <View style={styles.noteStacked}>{props.note}</View> : null}
            {/* Actions read primary-last on a wide bar; stacked, the primary leads under the thumb's first reach. */}
            <View style={styles.actionsStacked}>{props.children}</View>
          </View>
        ) : (
          // The bar's column is the page's, so the note starts on the sections' edge and the action ends on the page's.
          <PageFrame content="column" column={props.column} style={styles.footerRow}>
            <View style={styles.noteRow}>{props.note}</View>
            {props.children}
          </PageFrame>
        )}
      </PagePinnedBar>
    </KeyboardStickyFooter>
  );
}

/** "What it does": the description, said once, as the page's first section. */
export function BotTemplateWhatItDoes({
  description,
}: Readonly<{ description: string }>) {
  if (!description.trim()) return null;
  return (
    <ItemGroup title={t('botTemplates.whatItDoes')} surface="none">
      <Text variant="reading" selectable style={styles.reading}>{description}</Text>
    </ItemGroup>
  );
}

/** "What you get": the template's summary aside, shared by the recipient pages and the author's full page. */
export function BotTemplateWhatYouGet({
  content,
}: Readonly<{ content: BotTemplateContentV1 }>) {
  const skills = content.skills.map((skill) => skill.title).join(', ');
  return (
    <ItemGroup
      testID="bot-template-what-you-get"
      accessibilityLabel={t('botTemplates.whatYouGet')}
    >
      <SectionContentRow>
        <View style={styles.stack}>
          <Text variant="meta" style={styles.quiet}>
            {t('botTemplates.whatYouGet')}
          </Text>
          <View style={styles.identity}>
            <SessionBotFace
              facts={{
                seed: content.identity.name,
                face: content.identity.face ?? null,
              }}
              size={ASIDE_FACE_SIZE}
              motion={false}
            />
            <View style={styles.identityText}>
              <Text variant="label" emphasis="semiBold" numberOfLines={1} style={styles.ink}>
                {content.identity.name}
              </Text>
              <Text variant="meta" style={styles.quiet}>
                {t('botTemplates.yourOwnBot')}
              </Text>
            </View>
          </View>
          <View style={styles.facts}>
            <Fact
              icon="book-open"
              strong={t('botTemplates.asideInstructions')}
              rest={t('botTemplates.asideGeneralCopy')}
            />
            {content.memoryRules.length > 0 ? (
              <Fact
                icon="list"
                strong={t('botTemplates.asideMemory', {
                  count: content.memoryRules.length,
                })}
              />
            ) : null}
            {content.skills.length > 0 ? (
              <Fact
                icon="lightbulb"
                strong={t('botTemplates.asideSkills', {
                  count: content.skills.length,
                })}
                rest={skills}
              />
            ) : null}
          </View>
          <View style={styles.rule} />
          <Text variant="meta" style={styles.quiet}>
            {t('botTemplates.notIncluded')}
          </Text>
        </View>
      </SectionContentRow>
    </ItemGroup>
  );
}

function Fact(
  props: Readonly<{ icon: IconName; strong: string; rest?: string }>,
) {
  return (
    <View style={styles.fact}>
      <Icon name={props.icon} size={15} />
      <Text variant="body" style={styles.factText}>
        <Text variant="body" emphasis="medium">
          {props.strong}
        </Text>
        {props.rest ? (
          <Text variant="body" style={styles.quiet}>{` · ${props.rest}`}</Text>
        ) : null}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  stack: { gap: theme.space.s12 },
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
  },
  identityText: { flex: 1, minWidth: 0, gap: theme.space.s2 },
  facts: { gap: theme.space.s8 },
  fact: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space.s8 },
  factText: { flex: 1, minWidth: 0, color: theme.colors.text.primary },
  rule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.border.subtle,
  },
  quiet: { color: theme.colors.text.secondary },
  page: { flex: 1, minHeight: 0 },
  footerRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8, paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx },
  footerStacked: { gap: theme.space.s8 },
  actionsStacked: { flexDirection: 'column-reverse', gap: theme.space.s8 },
  noteRow: { flex: 1, minWidth: 0 },
  noteStacked: { alignItems: 'center' },
  ink: { color: theme.colors.text.primary },
  reading: { paddingHorizontal: HAPPIER_PAGE_METRICS.headingOpticalInsetPx, color: theme.colors.text.primary },
}));
