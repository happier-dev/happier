import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { OrderedBot } from '@/components/sessions/bots/botActivity';
import {
  orderedBotAccessibilityLabel,
  useOrderedBotNames,
  useOrderedBots,
} from '@/components/sessions/bots/botsSummary';
import { BotFaceMarker } from '@/components/sessions/bots/BotFaceMarker';
import { Text } from '@/components/ui/text/Text';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';

import { HomeHubReadingColumn } from './HomeHubSectionList';

const FACE_SIZE_PX = 44;

/**
 * Phone Home's row of Bot faces (owner 11-06, lab mnBots B): every Bot in roster order, one tap to its
 * conversation, sideways when more faces than fit. The person turns it off in Appearance › Home; off,
 * nothing here reads the Bot projection.
 */
export const HomeBotFaces = React.memo(function HomeBotFaces(
  props: Readonly<{ visible?: boolean }>,
) {
  const enabled = useSetting('homeBotFacesEnabled') !== false;
  const bots = useOrderedBots(enabled);
  if (!enabled || bots.length === 0) return null;
  return <HomeBotFacesRow bots={bots} visible={props.visible ?? true} />;
});

function HomeBotFacesRow(
  props: Readonly<{ bots: readonly OrderedBot[]; visible: boolean }>,
) {
  const { bots, visible } = props;
  const names = useOrderedBotNames(bots);
  const navigateToSession = useNavigateToSession();
  return (
    <HomeHubReadingColumn>
      {/* On the reading column's edges, like the brief's entry under it. */}
      <ItemGroup surface="none">
      <ScrollView
        testID="home-bot-faces"
        horizontal
        showsHorizontalScrollIndicator={false}
        accessibilityLabel={t('bots.title')}
        contentContainerStyle={styles.row}
      >
        {bots.map((bot, index) => {
          const name = names[index] ?? '';
          return (
            <Pressable
              key={bot.key}
              testID={`home-bot-faces.${bot.key}`}
              accessibilityRole="button"
              accessibilityLabel={orderedBotAccessibilityLabel(bot, name)}
              onPress={() => {
                void navigateToSession(bot.sessionId, {
                  serverId: bot.serverId,
                });
              }}
              style={styles.face}
            >
              {/* The face says working with its mouth; needs-you adds the attention dot, as every row of faces does. */}
              <BotFaceMarker
                facts={bot.face}
                size={FACE_SIZE_PX}
                activity={bot.activity}
                motion
                visible={visible}
                testID={`home-bot-faces.${bot.key}.face`}
              />
              <Text variant="micro" numberOfLines={1} style={styles.name}>
                {name}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
      </ItemGroup>
    </HomeHubReadingColumn>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: 'row',
    gap: theme.space.s12,
    paddingVertical: theme.space.s8,
  },
  face: {
    alignItems: 'center',
    gap: theme.space.s4,
    width: FACE_SIZE_PX + theme.space.s16,
  },
  name: {
    color: theme.colors.text.secondary,
    // The name keeps to its face's cell and truncates there, so neighbours never overlap.
    alignSelf: 'stretch',
    textAlign: 'center',
  },
}));
