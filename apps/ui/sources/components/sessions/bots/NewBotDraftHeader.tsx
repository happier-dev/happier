import * as React from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { SessionBotFaceV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { useComposerTextValue } from '@/components/sessions/agentInput/composerTextStore';
import { useComposerKeyboardLayout } from '@/components/sessions/keyboardAvoidance/ComposerKeyboardContext';
import type { NewSessionBotCreationModel } from '@/components/sessions/new/hooks/newSessionScreenModelTypes';
import { Icon } from '@/components/ui/icons/Icon';
import {
  PageHeader,
  renderPageHeaderText,
} from '@/components/ui/layout/PageHeader';
import { motionTokens } from '@/components/ui/motion';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { PAGE_HEADER_MARK_SLOT_SIZE_PX } from '@/components/ui/layout/PageHeaderMarkSlot';
import { HAPPIER_PAGE_TEXT, HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { t } from '@/text';

import { BotFacePicker, surpriseBotFaceShape, applyBotFacePickerGesture } from './BotFacePicker';
import { BOTS_GLYPH } from './botsGlyph';
import { SessionBotFace } from './face/SessionBotFace';

/**
 * The face the Bot will be born with stands on the name's own line at that line's height, and the purpose runs
 * flush left under both (owner 2026-11-11, New bot 02: a two-line mark slot left empty space above and below it).
 * The Bots glyph stands in only for a draft that carries no face seed.
 */
const BOT_DRAFT_GLYPH_SIZE_PX = HAPPIER_PAGE_TEXT.pageTitle.lineHeight;

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
        titleLeading={
          <View testID="new-bot-draft-mark" style={stylesheet.mark}>
            {props.botCreation.face?.seed ? (
              <>
                <NewBotDraftFace
                  face={props.botCreation.face}
                  seed={props.botCreation.face.seed}
                  onFaceChange={props.botCreation.onFaceChange}
                  sizePx={BOT_DRAFT_GLYPH_SIZE_PX}
                />
                {props.botCreation.onFaceChange ? (
                  <ShuffleFaceGlyph
                    face={props.botCreation.face}
                    seed={props.botCreation.face.seed}
                    onFaceChange={props.botCreation.onFaceChange}
                  />
                ) : null}
              </>
            ) : (
              <Icon
                name={BOTS_GLYPH}
                size={BOT_DRAFT_GLYPH_SIZE_PX}
                color={theme.colors.text.secondary}
              />
            )}
          </View>
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
  /** A size set by the line it stands on (the New bot name line), instead of a mark slot. */
  sizePx?: number;
}>;

/** The face the Bot will be born with, as the page mark (lab `r6-shell-N`): press it to choose another. */
export function NewBotDraftFace(props: DraftFaceProps) {
  const { theme } = useUnistyles();
  const anchorRef = React.useRef<View | null>(null);
  const [open, setOpen] = React.useState(false);
  const facts = React.useMemo(() => ({ seed: props.seed, face: props.face }), [props.seed, props.face]);
  const faceSizePx = props.sizePx ?? PAGE_HEADER_MARK_SLOT_SIZE_PX[props.size ?? 'page'];
  const face = <SessionBotFace facts={facts} size={faceSizePx}
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
        style={(state) => [{ borderRadius: faceSizePx / 2 }, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
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

/**
 * A new generated shape, one tap from the face (owner 2026-11-11, New bot 02, replacing "Surprise me"): a quiet
 * glyph on the face's top-right corner, no chrome, the picker's own dice.
 */
function ShuffleFaceGlyph(props: Readonly<{ face: SessionBotFaceV1; seed: string; onFaceChange: (face: SessionBotFaceV1 | null) => void }>) {
  return (
    <View style={stylesheet.shuffle} pointerEvents="box-none">
      <IconButton
        testID="new-bot-shuffle-face"
        variant="plain"
        iconName="shuffle"
        size={SHUFFLE_GLYPH_SQUARE_PX}
        accessibilityLabel={t('bots.face.shuffle')}
        tooltip={t('bots.face.shuffle')}
        tooltipPlacement="top"
        onPress={() => props.onFaceChange(applyBotFacePickerGesture(props.face, props.seed, { kind: 'surprise', shape: surpriseBotFaceShape() }))}
      />
    </View>
  );
}

/** The glyph's square: small enough to sit on the face's corner without covering it. */
const SHUFFLE_GLYPH_SQUARE_PX = 18;

const stylesheet = StyleSheet.create((theme) => ({
  mark: {
    position: 'relative',
  },
  shuffle: {
    position: 'absolute',
    top: -SHUFFLE_GLYPH_SQUARE_PX / 2,
    right: -SHUFFLE_GLYPH_SQUARE_PX / 2,
  },
  root: {
    // The card follows the purpose line closely: it is the same composer, not the next page section.
    paddingBottom: theme.space.s8,
  },
}));
