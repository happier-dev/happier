import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Text } from '@/components/ui/text/Text';
import { VoiceMarkArt } from '@/components/voice/presence/VoiceMark';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/** The planet is Happier's identity; it stands still here (no live energy source). */
export const ASK_HAPPIER_MARK_SIZE_PX = 30;
const ASK_HAPPIER_NOTE_MARK_SIZE_PX = 20;

/** Happier's planet identity at rest, for every Ask Happier entry (no mascot, no tile behind it). */
export const AskHappierMark = React.memo(function AskHappierMark(
  props: Readonly<{ size: number }>,
) {
  return <VoiceMarkArt pose="ready" size={props.size} still presentationOnly />;
});

/**
 * The explicit, opt-in Ask Happier offer (lab `b-rail G`): the planet, what it does in one line,
 * then Start · Not now · Don't show again. It owns no visibility: the host renders it only while
 * `useAskHappierOfferVisible()` says so and wires the three choices to `useAskHappierOfferChoices()`.
 */
export const AskHappierOfferCard = React.memo(function AskHappierOfferCard(
  props: Readonly<{
    onStart: () => void;
    onNotNow: () => void;
    onDontShowAgain: () => void;
    /** A narrower host (the phone roster sheet): the same anatomy with less inset. */
    compact?: boolean;
    testID?: string;
  }>,
) {
  const styles = stylesheet;
  const testID = props.testID ?? 'ask-happier-offer';
  return (
    <View
      testID={testID}
      accessibilityRole="summary"
      accessibilityLabel={t('bots.guide.offer')}
      style={[styles.root, props.compact ? styles.rootCompact : null]}
    >
      <View style={styles.head}>
        <AskHappierMark size={ASK_HAPPIER_MARK_SIZE_PX} />
        <View style={styles.text}>
          <Text style={styles.title}>{t('bots.guide.offer')}</Text>
          <Text style={styles.line}>{t('bots.guide.line')}</Text>
        </View>
      </View>
      <View style={[styles.actions, props.compact ? null : styles.actionsUnderText]}>
        <RoundButton
          testID={`${testID}.start`}
          size="small"
          title={t('bots.guide.start')}
          onPress={props.onStart}
        />
        <RoundButton
          testID={`${testID}.notNow`}
          size="small"
          display="secondary"
          title={t('bots.guide.notNow')}
          onPress={props.onNotNow}
        />
        <View style={styles.grow} />
        {/* Lab `b-rail G`: a quiet text link, not a third button. */}
        <TextLinkButton
          testID={`${testID}.dontShowAgain`}
          tone="strong"
          label={t('bots.guide.dontShowAgain')}
          onPress={props.onDontShowAgain}
        />
      </View>
    </View>
  );
});

/** The one contextual link a status row carries (lab `b-ask E`): words ending the status sentence, not a button. */
export const AskHappierStatusLink = React.memo(function AskHappierStatusLink(
  props: Readonly<{ onPress: () => void }>,
) {
  return (
    <TextLinkButton
      testID="ask-happier-status-link"
      tone="strong"
      label={t('bots.guide.offer')}
      onPress={props.onPress}
    />
  );
});

/**
 * Where Ask Happier is offered at the end of a story (lab `b-ask SH`): the planet and two sentences
 * saying what pressing the action beside it starts. It is a note, never a control.
 */
export const AskHappierNote = React.memo(function AskHappierNote(
  props: Readonly<{ testID?: string }>,
) {
  const styles = stylesheet;
  return (
    <View testID={props.testID ?? 'ask-happier-note'} style={styles.note}>
      <AskHappierMark size={ASK_HAPPIER_NOTE_MARK_SIZE_PX} />
      <Text style={styles.noteText}>
        <Text style={styles.noteLead}>{t('bots.guide.noteLead')}</Text>{' '}
        {t('bots.guide.noteLine')}
      </Text>
    </View>
  );
});

const stylesheet = StyleSheet.create((theme) => ({
  root: {
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  rootCompact: {
    paddingHorizontal: 12,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  text: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  title: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('rowTitle'),
    color: theme.colors.text.primary,
  },
  line: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.secondary,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  // The buttons start under the text, as the lab's card does.
  actionsUnderText: {
    marginLeft: ASK_HAPPIER_MARK_SIZE_PX + 12,
  },
  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 12,
    borderRadius: 14,
    backgroundColor: theme.colors.surface.selected,
  },
  noteText: {
    flex: 1,
    minWidth: 0,
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.secondary,
  },
  noteLead: {
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
  },
  grow: {
    flexGrow: 1,
  },
}));
