import * as React from 'react';
import { Platform, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
  ReduceMotion,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { HappierPressable, type HappierFocusable } from '@happier-dev/plugin-ui/presentation';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { WordCrossFade } from '@/components/ui/motion/WordCrossFade';
import { Icon } from '@/components/ui/icons/Icon';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Tooltip } from '@/components/ui/overlays/Tooltip';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';
import { isEmptyEdit } from '@happier-dev/protocol/sessions/media/imageMarksV1';
import { resolveCaptureDefaultTarget } from '@/components/screenCapture/main/resolveCaptureDefaultTarget';
import { readSessionChooserPage } from '@/components/sessions/selection/readSessionChooserPage';
import { SessionChooser } from '@/components/sessions/selection/SessionChooser';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

import { AnnotatorHistoryButtons } from '../annotation/AnnotatorPalette';
import type { ImageAnnotator } from '../annotation/annotatorStore';
import { useImageAnnotator, useImageAnnotatorState } from '../annotation/useImageAnnotator';
import type { StageAnnotationSession } from './useMediaStageAnnotation';

/**
 * What the right capsule says while annotating (MIS §8): the working pair, the inline discard question
 * when Cancel would lose marks, and the in-place Undo a Revert offers until the next change.
 */
export type StageAnnotateCapsule = 'editing' | 'confirmDiscard' | 'reverted';

/**
 * The annotator for one open session. It lives only while annotating (its keyboard commands with it) and
 * hands itself to the stage, whose palette, canvas and capsule all draw the same instance.
 */
export function StageAnnotatorMount(
  props: Readonly<{
    session: StageAnnotationSession;
    onAnnotator: (annotator: ImageAnnotator | null) => void;
  }>,
) {
  const annotator = useImageAnnotator({
    source: props.session.source,
    initial: props.session.initial,
  });
  const { onAnnotator } = props;
  React.useLayoutEffect(() => {
    // The stage has no note to type in, so tool keys and Delete reach the canvas at once.
    annotator.setCanvasFocused(true);
    onAnnotator(annotator);
    return () => onAnnotator(null);
  }, [annotator, onAnnotator]);
  return null;
}

/** The capsule reshapes on the travel spring while its words cross-fade, so nothing jumps (MIS §8.1). */
export function useStageCapsuleLayout() {
  const reducedMotion = useReducedMotionPreference();
  return React.useMemo(
    () =>
      reducedMotion
        ? undefined
        : LinearTransition.springify()
            .duration(reanimatedMotionTokens.spring.travel.duration)
            .dampingRatio(reanimatedMotionTokens.spring.travel.dampingRatio)
            .reduceMotion(ReduceMotion.Never),
    [reducedMotion],
  );
}

/** The way in, named in words because nothing else on the stage says marks are possible (lab `ia · I1`). */
export function StageAnnotateEntry(props: Readonly<{ tooltip: string; onPress: () => void; phone?: boolean;
  /** A paused video's frame is still being read: the entry shows progress and takes no second press. */
  busy?: boolean }>) {
  const { theme } = useUnistyles();
  return (
    <>
      <Tooltip label={props.tooltip} focusable={false}>
        <HappierPressable
          accessibilityRole="button"
          accessibilityLabel={t('files.annotate.annotate')}
          busy={props.busy === true}
          onPress={props.onPress}
          testID="media-stage-annotate"
          style={({ hovered }) => [styles.entry, hovered ? { backgroundColor: theme.colors.surface.hover } : null]}
        >
          {props.busy ? <ActivitySpinner size="small" color={theme.colors.text.secondary} />
            : <Icon name="pencil-circle" size={ENTRY_ICON_SIZE} color={theme.colors.text.primary} />}
          <Text variant="body" emphasis="medium" style={{ color: theme.colors.text.primary }}>
            {t('files.annotate.annotate')}
          </Text>
        </HappierPressable>
      </Tooltip>
      {props.phone ? null : <View style={[styles.entryDivider, { backgroundColor: theme.colors.border.surface }]} />}
    </>
  );
}

export function StageAnnotateActions(
  props: Readonly<{
    annotator: ImageAnnotator;
    capsule: StageAnnotateCapsule;
    onCapsule: (capsule: StageAnnotateCapsule) => void;
    done: { busy: boolean; onPress: () => void; anchorRef: React.RefObject<View | null> };
    onDiscard: () => void;
    /** A phone stands Undo and Redo here, and Revert moves to the end of the tool row (MIS §3.7, §9). */
    phone: boolean;
  }>,
) {
  const { theme } = useUnistyles();
  const { annotator, capsule, onCapsule } = props;
  const keepRef = React.useRef<HappierFocusable | null>(null);
  // The discard question lands on the choice that loses nothing (MIS §8.4). The word swap holds the words
  // hidden until its animation starts, and a hidden element refuses focus, so this asks again each frame.
  React.useEffect(() => {
    if (capsule !== 'confirmDiscard') return;
    let frame = 0;
    const land = () => {
      const node = keepRef.current;
      node?.focus();
      if (Platform.OS === 'web' && document.activeElement !== (node as unknown as Element)) frame = requestAnimationFrame(land);
    };
    frame = requestAnimationFrame(land);
    return () => cancelAnimationFrame(frame);
  }, [capsule]);
  const canRevert = useImageAnnotatorState(annotator, (state) => !isEmptyEdit(state.document));
  const revision = useImageAnnotatorState(annotator, (state) => state.revision);
  const revertedAt = React.useRef<number | null>(null);
  // Undo stays offered in place until the next change (MIS §8.5).
  React.useEffect(() => {
    if (capsule === 'reverted' && revertedAt.current !== null && revision !== revertedAt.current) onCapsule('editing');
  }, [capsule, onCapsule, revision]);
  const revert = React.useCallback(() => {
    annotator.apply([{ kind: 'reset' }]);
    revertedAt.current = annotator.store.getState().revision;
    onCapsule('reverted');
  }, [annotator, onCapsule]);
  const undoRevert = React.useCallback(() => {
    revertedAt.current = null;
    annotator.undo();
    onCapsule('editing');
  }, [annotator, onCapsule]);
  return (
    <WordCrossFade wordKey={props.capsule} style={styles.row}>
      {props.capsule === 'confirmDiscard' ? (
        <>
          <Text variant="body" emphasis="medium" style={styles.prompt}>
            {t('files.annotate.discardPrompt')}
          </Text>
          <View style={styles.link}>
            <TextLinkButton
              label={t('files.annotate.keepEditing')}
              tone="strong"
              controlRef={(node) => {
                keepRef.current = node;
              }}
              onPress={() => onCapsule('editing')}
              testID="media-stage-annotate-keep"
            />
          </View>
          <RoundButton
            size="small"
            capsuleHeight={CAPSULE_ACTION_HEIGHT}
            display="destructive"
            title={t('files.annotate.discard')}
            onPress={props.onDiscard}
            testID="media-stage-annotate-discard"
          />
        </>
      ) : (
        <>
          {props.phone ? (
            <AnnotatorHistoryButtons annotator={annotator} />
          ) : props.capsule === 'reverted' ? (
            <View style={styles.link}>
              <TextLinkButton
                label={t('common.undo')}
                tone="quiet"
                onPress={undoRevert}
                testID="media-stage-annotate-undo-revert"
              />
            </View>
          ) : (
            <HappierPressable
              accessibilityRole="button"
              accessibilityLabel={t('files.annotate.revert')}
              disabled={!canRevert}
              onPress={revert}
              testID="media-stage-annotate-revert"
              style={({ hovered, disabled }) => [styles.revert, hovered && !disabled ? { backgroundColor: theme.colors.surface.hover } : null, disabled ? styles.revertDisabled : null]}
            >
              <Icon name="arrow-counter-clockwise" size={ENTRY_ICON_SIZE} color={theme.colors.text.secondary} />
              <Text variant="body" emphasis="medium" style={{ color: theme.colors.text.secondary }}>
                {t('files.annotate.revert')}
              </Text>
            </HappierPressable>
          )}
          <View ref={props.done.anchorRef} collapsable={false}>
            <RoundButton
              size="small"
              capsuleHeight={CAPSULE_ACTION_HEIGHT}
              title={t('files.annotate.done')}
              loading={props.done.busy}
              onPress={props.done.onPress}
              testID="media-stage-annotate-done"
            />
          </View>
        </>
      )}
    </WordCrossFade>
  );
}

/**
 * Copy mode's last step (P2 F2): the picture isn't editable where it lives, so Done asks which Session's
 * draft gets the marked copy. It mounts only then, so a stage that never copies reads no Session list.
 */
export function StageCopyChooser(
  props: Readonly<{
    anchorRef: React.RefObject<View | null>;
    targetSession?: SessionAddress;
    onChoose: (address: SessionAddress) => void;
    onClose: () => void;
  }>,
) {
  const [selected] = React.useState(() => resolveCaptureDefaultTarget({ targetSession: props.targetSession }));
  return (
    <SessionChooser
      open
      anchorRef={props.anchorRef}
      readPage={readSessionChooserPage}
      selected={selected}
      title={t('screenCapture.chooser.attachTo')}
      enterHint={t('screenCapture.chooser.copyHere')}
      onSelect={props.onChoose}
      onClose={props.onClose}
    />
  );
}

/**
 * The caption under the picture while annotating takes the strip's place (MIS §8.1): the picture's
 * name and size, and for a composer picture that marks stay editable until it is sent.
 */
export function StageAnnotateCaption(
  props: Readonly<{
    title: string;
    width: number | null;
    height: number | null;
    editableUntilSend: boolean;
    /** Done did not land: the one line says so, and the marks and Done stay (P2 D11). */
    failure: boolean;
    bottom: number;
  }>,
) {
  const { theme } = useUnistyles();
  const reducedMotion = useReducedMotionPreference();
  const parts = [
    props.title,
    props.width && props.height
      ? `${Math.round(props.width)} × ${Math.round(props.height)}`
      : null,
    props.editableUntilSend ? t('files.annotate.editableUntilSend') : null,
  ].filter(Boolean);
  return (
    <Animated.View
      pointerEvents="none"
      entering={FadeIn.duration(
        reducedMotion
          ? motionTokens.overlay.panel.reducedMotionFadeMs
          : motionTokens.overlay.panel.enterMs,
      )}
      exiting={FadeOut.duration(motionTokens.overlay.panel.exitMs)}
      style={[styles.caption, { bottom: props.bottom }]}
    >
      <Text
        variant="meta"
        numberOfLines={1}
        style={[
          { color: props.failure ? theme.colors.text.destructive : theme.colors.text.tertiary },
          Typography.tabular(),
        ]}
      >
        {props.failure ? t('files.annotate.doneFailed') : parts.join(' · ')}
      </Text>
    </Animated.View>
  );
}

/** Inline actions stand level with the capsule's round wells (`IconButton`'s default square). */
const CAPSULE_ACTION_HEIGHT = 28;
const ENTRY_ICON_SIZE = 16;

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
  },
  link: {
    paddingHorizontal: theme.space.s8,
  },
  entry: {
    height: CAPSULE_ACTION_HEIGHT,
    borderRadius: CAPSULE_ACTION_HEIGHT / 2,
    paddingHorizontal: theme.space.s8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
  },
  revert: {
    height: CAPSULE_ACTION_HEIGHT,
    borderRadius: CAPSULE_ACTION_HEIGHT / 2,
    paddingHorizontal: theme.space.s8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
  },
  revertDisabled: {
    opacity: 0.4,
  },
  entryDivider: {
    width: StyleSheet.hairlineWidth * 2,
    height: theme.space.s16,
    marginHorizontal: theme.space.s2,
  },
  prompt: {
    paddingLeft: theme.space.s8,
    color: theme.colors.text.primary,
  },
  caption: {
    position: 'absolute',
    left: theme.space.s16,
    right: theme.space.s16,
    alignItems: 'center',
  },
}));
