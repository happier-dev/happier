import * as React from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { SessionBotFaceV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { useComposerTextValue } from '@/components/sessions/agentInput/composerTextStore';
import { useComposerKeyboardLayout } from '@/components/sessions/keyboardAvoidance/ComposerKeyboardContext';
import type { NewSessionBotCreationModel } from '@/components/sessions/new/hooks/newSessionScreenModelTypes';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import {
  PageHeader,
  renderPageHeaderText,
} from '@/components/ui/layout/PageHeader';
import { motionTokens } from '@/components/ui/motion';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { PAGE_HEADER_MARK_SLOT_SIZE_PX, PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { t } from '@/text';

import { BotFacePicker, surpriseBotFaceShape, applyBotFacePickerGesture } from './BotFacePicker';
import { BOTS_GLYPH } from './botsGlyph';
import { SessionBotFace } from './face/SessionBotFace';

/**
 * The face the Bot will be born with takes the whole page mark slot, centred on the header's two lines (name and
 * purpose); the Bots glyph stands in only for a draft that carries no face seed.
 */
const BOT_DRAFT_GLYPH_SIZE_PX = PAGE_HEADER_MARK_SLOT_SIZE_PX.page;

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
  const setComposerInputFocused = useComposerKeyboardLayout()?.setComposerInputFocused;
  const handleNameFocus = React.useCallback(() => {
    setNaming(true);
    setComposerInputFocused?.(true);
  }, [setComposerInputFocused]);
  const handleNameCommit = React.useCallback(() => {
    setNaming(false);
    setComposerInputFocused?.(false);
  }, [setComposerInputFocused]);
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
      onFocus: handleNameFocus,
      // Enter and blur both end naming; the name is already in the draft.
      onCommit: handleNameCommit,
      testID: 'new-bot-name',
    }),
    [name, onSessionNameChange, handleNameFocus, handleNameCommit],
  );
  return (
    <View testID="new-bot-draft-header" style={stylesheet.root}>
      <PageHeader
        title={name.trim() || t('bots.name.placeholder')}
        alwaysShowTitle
        titleEditor={titleEditor}
        // The purpose line and the naming hint crossfade (lab `b-new` Motion, `durationMs.base`): the
        // leaving line fades where it stood while the new one arrives. The first render and reduced
        // motion place the sentence at once.
        description={
          <Animated.View
            key={naming ? 'hint' : 'purpose'}
            entering={
              reducedMotion || !swapped.current
                ? undefined
                : FadeIn.duration(motionTokens.durationMs.base)
            }
            exiting={
              reducedMotion
                ? undefined
                : FadeOut.duration(motionTokens.durationMs.base)
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
            {props.botCreation.face?.seed ? (
              <NewBotDraftFace
                face={props.botCreation.face}
                seed={props.botCreation.face.seed}
                onFaceChange={props.botCreation.onFaceChange}
              />
            ) : (
              <Icon
                name={BOTS_GLYPH}
                size={BOT_DRAFT_GLYPH_SIZE_PX}
                color={theme.colors.text.secondary}
              />
            )}
          </PageHeaderMarkSlot>
        }
        actions={
          props.botCreation.face?.seed && props.botCreation.onFaceChange ? (
            <SurpriseFaceButton
              face={props.botCreation.face}
              seed={props.botCreation.face.seed}
              onFaceChange={props.botCreation.onFaceChange}
            />
          ) : undefined
        }
      />
    </View>
  );
});

type DraftFaceProps = Readonly<{
  face: SessionBotFaceV1;
  seed: string;
  onFaceChange?: (face: SessionBotFaceV1 | null) => void;
  /** The mark slot it fills: the page header's (default) or a row's (a template setup's "Your copy"). */
  size?: keyof typeof PAGE_HEADER_MARK_SLOT_SIZE_PX;
}>;

/** The face the Bot will be born with, as the page mark (lab `r6-shell-N`): press it to choose another. */
export function NewBotDraftFace(props: DraftFaceProps) {
  const { theme } = useUnistyles();
  const anchorRef = React.useRef<View | null>(null);
  const [open, setOpen] = React.useState(false);
  const facts = React.useMemo(() => ({ seed: props.seed, face: props.face }), [props.seed, props.face]);
  const face = <SessionBotFace facts={facts} size={props.size ? PAGE_HEADER_MARK_SLOT_SIZE_PX[props.size] : BOT_DRAFT_GLYPH_SIZE_PX}
    testID="new-bot-draft-face" />;
  if (!props.onFaceChange) return face;
  return (
    <View ref={anchorRef} collapsable={false}>
      <HappierPressable
        testID="new-bot-draft-face-button"
        accessibilityRole="button"
        accessibilityLabel={t('bots.face.change')}
        hasPopup="dialog"
        expanded={open}
        onPress={() => setOpen(true)}
        style={(state) => [stylesheet.facePress, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
      >
        {face}
      </HappierPressable>
      <BotFacePicker
        open={open}
        anchorRef={anchorRef}
        onRequestClose={() => setOpen(false)}
        seed={props.seed}
        face={props.face}
        onChange={props.onFaceChange}
      />
    </View>
  );
}

/** Surprise me, one tap from the header (lab `b-new`, R8): the picker's one dice, a new generated shape. */
function SurpriseFaceButton(props: Required<DraftFaceProps>) {
  const { theme } = useUnistyles();
  return (
    <ToolbarButton
      testID="new-bot-surprise-face"
      label={t('bots.face.surprise')}
      icon={<Icon name="shuffle" size={ICON_SIZE.sm} color={theme.colors.text.primary} />}
      onPress={() => props.onFaceChange(applyBotFacePickerGesture(props.face, props.seed, { kind: 'surprise', shape: surpriseBotFaceShape() }))}
    />
  );
}

const stylesheet = StyleSheet.create({
  facePress: {
    borderRadius: BOT_DRAFT_GLYPH_SIZE_PX / 2,
  },
  root: {
    // The composer card follows the purpose line on the page's section rhythm.
    paddingBottom: 16,
  },
});
