import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { createFrontDoorUiActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { localVoiceTtsController } from '@/voice/backends/tts/localVoiceTtsController';

export type VoiceReadAloudPhase = ReturnType<
  typeof localVoiceTtsController.readSay
>;
export type VoiceReadAloud = Readonly<{
  phase: VoiceReadAloudPhase;
  stop: () => void;
}>;

const executePresentationAction = createFrontDoorUiActionExecutor();
const stopReadAloud = (): void => {
  fireAndForget(executePresentationAction('ui.voice_global.say.stop', {}), {
    tag: 'VoiceReadAloud.stop',
  });
};

/**
 * Read-aloud ("say this") as the Voice presence shows it: the output owner's phase and a Stop that
 * goes through the same Action an Agent or a shortcut would use. Nothing here keeps the spoken text.
 */
export function useVoiceReadAloud(): VoiceReadAloud {
  const phase = React.useSyncExternalStore(
    localVoiceTtsController.subscribeSay,
    localVoiceTtsController.readSay,
    localVoiceTtsController.readSay,
  );
  return React.useMemo(() => ({ phase, stop: stopReadAloud }), [phase]);
}

export type VoiceReadAloudSize = 'pill' | 'island';

const METRICS: Readonly<
  Record<
    VoiceReadAloudSize,
    Readonly<{
      fontSize: number;
      lineHeight: number;
      glyph: number;
      button: number;
      icon: number;
    }>
  >
> = {
  pill: { fontSize: 12.5, lineHeight: 16, glyph: 15, button: 24, icon: 15 },
  island: { fontSize: 13, lineHeight: 17, glyph: 18, button: 32, icon: 16 },
};

/** The speaker glyph that takes the mark's place while Voice reads aloud outside a conversation. */
export function VoiceReadAloudGlyph(
  props: Readonly<{ size: VoiceReadAloudSize }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  return (
    <Icon
      name="speaker-high"
      size={METRICS[props.size].glyph}
      color={theme.colors.text.secondary}
    />
  );
}

/** The status word, drawn like the conversation status word it stands in for. */
export function VoiceReadAloudStatus(
  props: Readonly<{
    phase: VoiceReadAloudPhase;
    size: VoiceReadAloudSize;
    testID?: string;
  }>,
): React.ReactElement {
  const metrics = METRICS[props.size];
  return (
    <Text
      testID={props.testID ?? 'voice-read-aloud-status'}
      numberOfLines={1}
      style={[
        styles.word,
        { fontSize: metrics.fontSize, lineHeight: metrics.lineHeight },
      ]}
    >
      {props.phase === 'preparing'
        ? t('voicePresence.readAloud.preparing')
        : t('voicePresence.readAloud.speaking')}
    </Text>
  );
}

/** Stop: the one control while Voice reads aloud. A quiet well in floating containers, a bare glyph in the pill. */
export function VoiceReadAloudStop(
  props: Readonly<{
    readAloud: VoiceReadAloud;
    size: VoiceReadAloudSize;
    testID?: string;
  }>,
): React.ReactElement {
  const metrics = METRICS[props.size];
  const label = t('voicePresence.readAloud.stop');
  return (
    <IconButton
      testID={props.testID ?? 'voice-read-aloud-stop'}
      iconName="stop"
      accessibilityLabel={label}
      tooltip={label}
      size={metrics.button}
      iconSize={metrics.icon}
      {...(props.size === 'island'
        ? { fill: 'neutral' as const }
        : { variant: 'plain' as const })}
      onPress={props.readAloud.stop}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  word: {
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
    flexShrink: 1,
  },
}));
