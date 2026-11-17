import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { BotMotion } from '@happier-dev/protocol/account/settings/accountSettings';
import type { BotFaceMood } from '@happier-dev/protocol/sessions/identity/botFaceGeometry';

import { BotFace } from '@/components/sessions/bots/face/BotFace';
import { resolveBotFaceIdentity } from '@/components/sessions/bots/face/botFaceIdentity';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { Text } from '@/components/ui/text/Text';

const MODES: readonly Readonly<{ mode: BotMotion; title: string }>[] = [
  { mode: 'lively', title: 'Lively' },
  { mode: 'reactions', title: 'Reactions only' },
  { mode: 'still', title: 'Still' },
];

/** Lab R10 `r10-states`: one Bot per state, named like the lab's cast. */
const CAST: readonly Readonly<{
  seed: string;
  name: string;
  mood: BotFaceMood;
}>[] = [
  { seed: 'metrics', name: 'At rest', mood: 'quiet' },
  { seed: 'release-captain', name: 'Working', mood: 'working' },
  { seed: 'flake-hunter', name: 'Needs you', mood: 'needsYou' },
  { seed: 'docs-gardener', name: 'Done', mood: 'done' },
  { seed: 'mac-tester', name: 'Failed', mood: 'failed' },
];

const RAIL_FACE_PX = 24;
const HERO_FACE_PX = 72;

/**
 * Dev-only: every Bot state at rail size and as a hero, in each Appearance › Bots motion mode, through the real
 * `BotFace` with its `motionMode` (the value the Account setting supplies). "Replay the facts" stamps a fresh
 * completion and failure, so the done and failed reactions play from the owner. Reduced motion is the OS
 * preference, so emulate it in the browser. Never reads or writes the Account's settings.
 */
export function BotMotionSpecimen() {
  const [factsAt, setFactsAt] = React.useState<number | null>(null);
  const replay = React.useCallback(() => setFactsAt(Date.now()), []);
  return (
    <View testID="bot-motion-specimen" style={styles.root}>
      <PageHeader
        title="Bot motion"
        description="Every state at rail size and as a hero, in each motion mode. Replay the facts to play done and failed."
        actions={
          <RoundButton
            display="secondary"
            title="Replay the facts"
            onPress={replay}
            testID="bot-motion-specimen.replay"
          />
        }
      />
      {MODES.map(({ mode, title }) => (
        <View
          key={mode}
          style={styles.mode}
          testID={`bot-motion-specimen.${mode}`}
        >
          <Text variant="heading" style={styles.title}>
            {title}
          </Text>
          <View style={styles.row}>
            {CAST.map((bot) => (
              <View key={bot.seed} style={styles.cell}>
                <BotFace
                  identity={resolveBotFaceIdentity(bot.seed)}
                  style="dither"
                  size={RAIL_FACE_PX}
                  mood={
                    bot.mood === 'done' || bot.mood === 'failed'
                      ? 'quiet'
                      : bot.mood
                  }
                  visible
                  motion
                  motionMode={mode}
                  completedAt={bot.mood === 'done' ? factsAt : null}
                  failedAt={bot.mood === 'failed' ? factsAt : null}
                />
                <Text variant="meta" style={styles.caption}>
                  {bot.name}
                </Text>
              </View>
            ))}
            <View style={styles.cell}>
              <BotFace
                identity={resolveBotFaceIdentity('flake-hunter')}
                style="dither"
                size={HERO_FACE_PX}
                mood="quiet"
                visible
                motion
                motionMode={mode}
              />
              <Text variant="meta" style={styles.caption}>
                Hero
              </Text>
            </View>
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.surface.base,
    padding: theme.space.s24,
    gap: theme.space.s24,
  },
  mode: { gap: theme.space.s12 },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    gap: theme.space.s24,
  },
  cell: { alignItems: 'center', gap: theme.space.s6 },
  title: { color: theme.colors.text.primary },
  caption: { color: theme.colors.text.secondary },
}));
