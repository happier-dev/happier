import * as React from 'react';
import { View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useComposerTextValue } from '@/components/sessions/agentInput/composerTextStore';
import type { NewSessionBotCreationModel } from '@/components/sessions/new/hooks/newSessionScreenModelTypes';
import { Icon } from '@/components/ui/icons/Icon';
import {
  PageHeader,
  renderPageHeaderText,
} from '@/components/ui/layout/PageHeader';
import { motionTokens } from '@/components/ui/motion';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { t } from '@/text';

import { BOTS_GLYPH } from './botsGlyph';

/** The Bots glyph stands for a bot until its Session exists and shows its own seeded avatar. */
const BOT_DRAFT_GLYPH_SIZE_PX = 28;

/**
 * The New bot draft's identity (lab `b-new A/N`, D30): the page title IS the name field. Empty shows
 * the "New bot" placeholder and means the bot names itself; a typed name stays with the draft. While
 * the name is being edited the purpose line becomes the naming hint. It subscribes to the name store
 * itself, so typing re-renders this header and nothing above it.
 */
export const NewBotDraftHeader = React.memo(function NewBotDraftHeader(
  props: Readonly<{
    botCreation: NewSessionBotCreationModel;
  }>,
) {
  const { theme } = useUnistyles();
  const name = useComposerTextValue(props.botCreation.nameStore);
  const [naming, setNaming] = React.useState(false);
  const reducedMotion = useReducedMotionPreference();
  // The sentence the page opens with never animates in; only a swap does.
  const swapped = React.useRef(false);
  if (naming) swapped.current = true;
  const onSessionNameChange = props.botCreation.onSessionNameChange;
  const titleEditor = React.useMemo(
    () => ({
      value: name,
      placeholder: t('bots.name.placeholder'),
      accessibilityLabel: t('bots.name.label'),
      accessibilityHint: t('bots.name.hint'),
      onChangeText: onSessionNameChange,
      onFocus: () => setNaming(true),
      // Enter and blur both end naming; the name is already in the draft.
      onCommit: () => setNaming(false),
      testID: 'new-bot-name',
    }),
    [name, onSessionNameChange],
  );
  return (
    <View testID="new-bot-draft-header" style={stylesheet.root}>
      <PageHeader
        title={name.trim() || t('bots.name.placeholder')}
        alwaysShowTitle
        titleEditor={titleEditor}
        // The purpose line becomes the naming hint and back with a soft arrival (lab `b-new` Motion);
        // the first render and reduced motion place the sentence at once.
        description={
          <Animated.View
            key={naming ? 'hint' : 'purpose'}
            entering={
              reducedMotion || !swapped.current
                ? undefined
                : FadeIn.duration(motionTokens.durationMs.base)
            }
          >
            {renderPageHeaderText({
              role: 'pageDescription',
              header: false,
              text: naming ? t('bots.name.hint') : t('bots.create.description'),
            })}
          </Animated.View>
        }
        leading={
          <PageHeaderMarkSlot testID="new-bot-draft-mark">
            <Icon
              name={BOTS_GLYPH}
              size={BOT_DRAFT_GLYPH_SIZE_PX}
              color={theme.colors.text.secondary}
            />
          </PageHeaderMarkSlot>
        }
      />
    </View>
  );
});

const stylesheet = StyleSheet.create({
  root: {
    // The composer card follows the purpose line on the page's section rhythm.
    paddingBottom: 16,
  },
});
