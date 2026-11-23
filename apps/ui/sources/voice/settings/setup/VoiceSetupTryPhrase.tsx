import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type { VoiceSetupHeardPhrase } from './voiceSetupHeardPhrase';

/**
 * The try step's phrase card (lab `voice-moments` T1/SC "Say it out loud"): the suggested phrase,
 * lit word by word as the recognizer really hears it, the microphone line while Voice listens, and
 * the reply beneath. Presentation only: every fact arrives from the live readout's owners.
 */
export const VoiceSetupTryPhrase = React.memo(function VoiceSetupTryPhrase(
  props: Readonly<{
    testID: string;
    heard: VoiceSetupHeardPhrase;
    /** The microphone line, shown only while a conversation runs. */
    microphone?: Readonly<{
      label: string;
      state: string;
      trailing?: React.ReactNode;
    }> | null;
    reply?: string | null;
  }>,
) {
  const { theme } = useUnistyles();
  const styles = stylesheet;
  const { heard } = props;
  return (
    <View testID={props.testID} style={styles.root}>
      <View style={styles.card}>
        <Text style={styles.lead}>{t('voiceMoments.setupTryLead')}</Text>
        {heard.kind === 'own' ? (
          <Text testID={`${props.testID}.heard`} style={styles.phraseHeard}>
            {heard.text}
          </Text>
        ) : (
          // Before the try starts the phrase is the instruction, in full ink; while Voice listens the
          // words not heard yet recede until recognition reaches them.
          <Text style={props.microphone ? styles.phraseUnheard : styles.phraseHeard}>
            {heard.heard ? (
              <Text testID={`${props.testID}.heard`} style={styles.phraseHeard}>
                {heard.heard}
              </Text>
            ) : null}
            {heard.rest}
          </Text>
        )}
        {props.microphone ? (
          <View style={styles.micLine}>
            <Icon
              name="microphone"
              size={14}
              color={theme.colors.text.secondary}
            />
            <Text numberOfLines={1} style={styles.micLabel}>
              {props.microphone.label}
            </Text>
            <Text numberOfLines={1} style={styles.micState}>
              {props.microphone.state}
            </Text>
            {props.microphone.trailing}
          </View>
        ) : null}
      </View>
      {props.reply ? (
        <View testID={`${props.testID}.reply`} style={styles.reply}>
          <Text style={styles.replyLabel}>{t('voicePresence.title')}</Text>
          <Text numberOfLines={4} style={styles.replyText}>{props.reply}</Text>
        </View>
      ) : null}
    </View>
  );
});

const stylesheet = StyleSheet.create((theme) => ({
  root: {
    alignSelf: 'stretch',
    flexGrow: 1,
    flexBasis: '100%',
    gap: theme.space.s10,
  },
  card: {
    borderRadius: theme.borderRadius.lg,
    paddingTop: theme.space.s12,
    paddingBottom: theme.space.s10,
    paddingHorizontal: theme.space.s12,
    backgroundColor: theme.colors.state.info.background,
  },
  lead: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
    marginBottom: theme.space.s4,
  },
  phraseUnheard: {
    ...Typography.variant('heading'),
    color: theme.colors.text.disabled,
  },
  phraseHeard: {
    ...Typography.variant('heading'),
    color: theme.colors.text.primary,
  },
  micLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    marginTop: theme.space.s10,
  },
  micLabel: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
    flexShrink: 1,
  },
  micState: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
    marginLeft: 'auto',
    flexShrink: 0,
  },
  reply: {
    gap: theme.space.s2,
  },
  replyLabel: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
  },
  replyText: {
    ...Typography.variant('reading'),
    color: theme.colors.text.primary,
  },
}));
