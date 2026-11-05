import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
  IconButton,
  type IconButtonIconName,
} from '@/components/ui/buttons/IconButton';
import { GlassPanel } from '@/components/ui/glass/GlassPanel';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { Text } from '@/components/ui/text/Text';
import { hapticsSelection } from '@/components/ui/theme/haptics';
import { WordCrossFade } from '@/components/ui/motion/WordCrossFade';
import { useKeyboardHeight } from '@/hooks/ui/useKeyboardHeight';
import { useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import type { KeyboardCommandId } from '@/keyboard/types';
import { withShortcut } from '@/keyboard/withShortcut';
import { t } from '@/text';
import { isEmptyEdit } from '@happier-dev/protocol/sessions/media/imageMarksV1';

import { AnnotatorColorPanel, AnnotatorColorRow } from './AnnotatorColorPopover';
import { AnnotatorCropActions } from './AnnotatorCropActions';
import type { AnnotatorTool, ImageAnnotator } from './annotatorStore';
import { MARK_COLORS } from './markGeometry';
import { useImageAnnotatorState } from './useImageAnnotator';

type PaletteTool = Readonly<{
  tool: AnnotatorTool;
  icon: IconButtonIconName | 'step';
  command: KeyboardCommandId;
}>;

/** The tools, in the lab's order (MIS §3.1). Element follows Select and only a browser host offers it. */
const SELECT_TOOL: PaletteTool = { tool: 'select', icon: 'cursor', command: 'annotation.select' };
const ELEMENT_TOOL: PaletteTool = { tool: 'element', icon: 'selection', command: 'annotation.element' };
const MARK_TOOLS: readonly PaletteTool[] = [
  { tool: 'arrow', icon: 'arrow-up-right', command: 'annotation.arrow' },
  { tool: 'rectangle', icon: 'square', command: 'annotation.rectangle' },
  { tool: 'ellipse', icon: 'circle', command: 'annotation.ellipse' },
  { tool: 'freehand', icon: 'pencil-simple', command: 'annotation.freehand' },
  { tool: 'highlighter', icon: 'highlighter', command: 'annotation.highlighter' },
  { tool: 'text', icon: 'text-t', command: 'annotation.text' },
  { tool: 'step', icon: 'step', command: 'annotation.step' },
  { tool: 'blur', icon: 'grid-nine', command: 'annotation.blur' },
];
const CROP_TOOL: PaletteTool = { tool: 'crop', icon: 'crop', command: 'annotation.crop' };

/** A phone row keeps the 44 pt target as its drawn well (MIS §9, lab `ia · I2p`). */
const PHONE_TOOL_SIZE = 44;
const PHONE_GLYPH_SIZE = 22;

/**
 * The annotator's controls (contract 7): tools, Crop, the colour and stroke swatch, Undo and Redo. One row
 * on a desktop or web host; `surface` says what it stands on, the media stage floating it as a glass capsule
 * over arbitrary pixels and the Capture window setting it flat on its own paper (MIS R3-1). On a phone it
 * becomes two glass rows by the thumb, colour above tools, and Undo and Redo belong to the host's top
 * capsule (MIS §9).
 */
export function AnnotatorPalette(
  props: Readonly<{
    annotator: ImageAnnotator;
    layout: 'bar' | 'phone';
    surface: 'paper' | 'glass';
  }>,
) {
  if (props.layout === 'phone') return <PhonePalette annotator={props.annotator} />;
  const content = <PaletteRow annotator={props.annotator} />;
  if (props.surface === 'paper')
    return (
      <AnnotatorPaperCapsule testID="annotator-palette">
        {content}
      </AnnotatorPaperCapsule>
    );
  return (
    <GlassPanel
      shadowLevel={2}
      innerShadow={false}
      style={styles.row}
      testID="annotator-palette"
    >
      {content}
    </GlassPanel>
  );
}

/**
 * A capsule on a window's own paper: there is nothing behind it for glass to work with, so it takes the
 * unbacked paint, an ink fill with no blur or shadow (MIS R3-1). Its neighbours in the Capture window
 * stand in the same capsule.
 */
export function AnnotatorPaperCapsule(
  props: Readonly<{ children: React.ReactNode; testID?: string }>,
) {
  return (
    <View style={[styles.row, styles.paperCapsule]} testID={props.testID}>
      {props.children}
    </View>
  );
}

/**
 * The host's caption slot: the confirm capsule takes the caption's place while Crop is open, so nothing
 * jumps (MIS §3.6). `surface` matches the palette's.
 */
export function AnnotatorCaptionSlot(
  props: Readonly<{ annotator: ImageAnnotator; surface: 'paper' | 'glass'; children: React.ReactNode }>,
) {
  const cropping = useImageAnnotatorState(props.annotator, (state) => state.tool === 'crop');
  // The caption stays mounted and keeps its height under the capsule, so the host never changes size.
  return (
    <View>
      <View style={cropping ? styles.slotHidden : null} pointerEvents={cropping ? 'none' : 'auto'}
        importantForAccessibility={cropping ? 'no-hide-descendants' : 'auto'}>
        {props.children}
      </View>
      {cropping ? (
        <View style={styles.slotOverlay} pointerEvents="box-none">
          <WordCrossFade wordKey="crop">
            {props.surface === 'paper' ? (
              <AnnotatorPaperCapsule><AnnotatorCropActions annotator={props.annotator} /></AnnotatorPaperCapsule>
            ) : (
              <GlassPanel shadowLevel={2} innerShadow={false} style={styles.capsule}>
                <AnnotatorCropActions annotator={props.annotator} />
              </GlassPanel>
            )}
          </WordCrossFade>
        </View>
      ) : null}
    </View>
  );
}

function hasTool(annotator: ImageAnnotator, entry: PaletteTool): boolean {
  if (entry.tool === 'crop') return annotator.tools?.crop !== false;
  if (entry.tool === 'element') return annotator.tools?.element !== undefined;
  return true;
}

function paletteTools(annotator: ImageAnnotator): readonly PaletteTool[] {
  return [SELECT_TOOL, ...(hasTool(annotator, ELEMENT_TOOL) ? [ELEMENT_TOOL] : []), ...MARK_TOOLS];
}

function PaletteRow(props: Readonly<{ annotator: ImageAnnotator }>) {
  const { annotator } = props;
  return (
    <>
      <View
        style={styles.group}
        accessibilityRole="radiogroup"
        accessibilityLabel={t('files.annotate.tools.title')}
      >
        {paletteTools(annotator).map((entry) => (
          <ToolButton key={entry.tool} annotator={annotator} entry={entry} />
        ))}
      </View>
      {hasTool(annotator, CROP_TOOL) ? (
        <>
          <PaletteDivider />
          <ToolButton annotator={annotator} entry={CROP_TOOL} />
        </>
      ) : null}
      <PaletteDivider />
      <ColorSwatchButton annotator={annotator} />
      <PaletteDivider />
      <AnnotatorHistoryButtons annotator={annotator} />
    </>
  );
}

/** Tools run under an edge fade while they don't fit, so the row itself says there are more (lab `ia · I2p`). */
function PhonePalette(props: Readonly<{ annotator: ImageAnnotator }>) {
  const { annotator } = props;
  const { theme } = useUnistyles();
  const fades = useScrollEdgeFades({ enabledEdges: { left: true, right: true }, overflowThreshold: 4, edgeThreshold: 2 });
  const cropping = useImageAnnotatorState(annotator, (state) => state.tool === 'crop');
  // The rows make way for the keyboard while a text mark is typed (MIS §9).
  const keyboardUp = useKeyboardHeight() > 0;
  const tools = [...paletteTools(annotator), ...(hasTool(annotator, CROP_TOOL) ? [CROP_TOOL] : [])];
  const [trackWidth, setTrackWidth] = React.useState(0);
  // Revert ends the row after the tools.
  const toolGap = { gap: resolvePhoneToolGap(trackWidth, tools.length + 1, theme.space.s4) };
  return (
    <View style={[styles.phoneRows, keyboardUp ? styles.phoneRowsHidden : null]} testID="annotator-palette" pointerEvents="box-none">
      <GlassPanel shadowLevel={2} innerShadow={false} style={styles.phoneRow}>
        {cropping ? <AnnotatorCropActions annotator={annotator} /> : <PhoneColorRow annotator={annotator} />}
      </GlassPanel>
      <GlassPanel shadowLevel={2} innerShadow={false} style={styles.phoneRow}>
        <View
          style={styles.phoneTrack}
          onLayout={(event) => {
            fades.onViewportLayout(event);
            setTrackWidth(event.nativeEvent.layout.width);
          }}
        >
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={[styles.phoneTools, toolGap]}
            onContentSizeChange={fades.onContentSizeChange}
            onScroll={fades.onScroll}
            scrollEventThrottle={32}
            keyboardShouldPersistTaps="always"
          >
            <View style={[styles.phoneTools, toolGap]} accessibilityRole="radiogroup" accessibilityLabel={t('files.annotate.tools.title')}>
              {tools.map((entry) => (
                <ToolButton key={entry.tool} annotator={annotator} entry={entry} phone />
              ))}
            </View>
            <PaletteDivider />
            <PhoneRevertButton annotator={annotator} />
          </ScrollView>
          <ScrollEdgeFades color={theme.colors.surface.base} size={theme.space.s24} edges={fades.visibility} />
        </View>
      </GlassPanel>
    </View>
  );
}

/** The share of the first tool past the edge that stays in view while the row overflows: its glyph reads cut. */
const PHONE_TOOL_PEEK = 0.5;

/**
 * While the tools overflow, they spread so one stands cut at the edge and the row itself says it scrolls
 * (lab `ia · I2p`); a row that fits keeps the base gap.
 */
function resolvePhoneToolGap(width: number, count: number, minGap: number): number {
  const pitch = PHONE_TOOL_SIZE + minGap;
  if (width <= 0 || count * pitch <= width) return minGap;
  const whole = Math.max(1, Math.floor((width - PHONE_TOOL_PEEK * pitch) / pitch));
  return Math.max(minGap, width / (whole + PHONE_TOOL_PEEK) - PHONE_TOOL_SIZE);
}

function PhoneColorRow(props: Readonly<{ annotator: ImageAnnotator }>) {
  const { annotator } = props;
  const style = useImageAnnotatorState(annotator, (state) => state.style);
  return (
    <AnnotatorColorRow
      color={style.color}
      size={style.size}
      onColor={(color) => annotator.setStyle({ color })}
      onSize={(size) => annotator.setStyle({ size })}
    />
  );
}

/** Reopened marks have no undo history, so a phone keeps the way back to the original at the row's end. */
function PhoneRevertButton(props: Readonly<{ annotator: ImageAnnotator }>) {
  const { annotator } = props;
  const canRevert = useImageAnnotatorState(annotator, (state) => !isEmptyEdit(state.document));
  return (
    <IconButton
      variant="plain"
      size={PHONE_TOOL_SIZE}
      iconSize={PHONE_GLYPH_SIZE}
      iconName="arrow-counter-clockwise"
      accessibilityLabel={t('files.annotate.revert')}
      disabled={!canRevert}
      onPress={() => annotator.apply([{ kind: 'reset' }])}
      testID="annotator-revert"
    />
  );
}

/** Each tool subscribes to whether it is the tool, so switching repaints two buttons, not the palette. */
function ToolButton(
  props: Readonly<{ annotator: ImageAnnotator; entry: PaletteTool; phone?: boolean }>,
) {
  const { annotator, entry } = props;
  const shortcut = useKeyboardShortcutLabel(entry.command);
  const active = useImageAnnotatorState(
    annotator,
    (state) => state.tool === entry.tool,
  );
  const label = t(`files.annotate.tools.${entry.tool}` as const);
  return (
    <IconButton
      variant="plain"
      size={props.phone ? PHONE_TOOL_SIZE : undefined}
      iconSize={props.phone ? PHONE_GLYPH_SIZE : undefined}
      {...(entry.icon === 'step' ? { icon: <StepGlyph /> } : { iconName: entry.icon })}
      accessibilityRole="radio"
      checked={active}
      selected={active}
      accessibilityLabel={label}
      tooltip={props.phone ? undefined : withShortcut(label, shortcut)}
      tooltipPlacement="bottom"
      onPress={() => {
        if (!active) void hapticsSelection();
        annotator.setTool(entry.tool);
      }}
      testID={`annotator-tool-${entry.tool}`}
    />
  );
}

/** Neither icon family has a numbered mark, and the tool's whole point is that it counts. */
function StepGlyph() {
  const { theme } = useUnistyles();
  return (
    <View style={[styles.stepGlyph, { borderColor: theme.colors.text.primary }]}>
      <Text variant="micro" emphasis="semiBold" style={{ color: theme.colors.text.primary }}>1</Text>
    </View>
  );
}

function ColorSwatchButton(props: Readonly<{ annotator: ImageAnnotator }>) {
  const { theme } = useUnistyles();
  const { annotator } = props;
  const [open, setOpen] = React.useState(false);
  const anchorRef = React.useRef<View>(null);
  const style = useImageAnnotatorState(annotator, (state) => state.style);
  const showTextSize = useImageAnnotatorState(annotator, (state) => {
    if (state.tool === 'text') return true;
    return (
      state.selection !== null &&
      state.document.marks.some(
        (mark) => mark.id === state.selection && mark.kind === 'text',
      )
    );
  });
  const label = t('files.annotate.colourAndStroke');
  return (
    <>
      <View ref={anchorRef} collapsable={false}>
        <IconButton
          variant="plain"
          accessibilityLabel={label}
          tooltip={label}
          tooltipPlacement="bottom"
          tooltipHidden={open}
          hasPopup="dialog"
          expanded={open}
          selected={open}
          icon={
            <View
              style={[
                styles.swatchRing,
                { borderColor: theme.colors.border.strong },
              ]}
            >
              <View
                style={[
                  styles.swatchDot,
                  { backgroundColor: MARK_COLORS[style.color] },
                ]}
              />
            </View>
          }
          onPress={() => setOpen((value) => !value)}
          testID="annotator-color"
        />
      </View>
      <Popover
        open={open}
        anchorRef={anchorRef}
        onRequestClose={() => setOpen(false)}
        autoFocusOnOpen
        placement="bottom"
        portal={{
          web: true,
          native: true,
          matchAnchorWidth: false,
          anchorAlign: 'center',
          sizeToContent: true,
        }}
      >
        {({ maxHeight }) => (
          <FloatingOverlay maxHeight={maxHeight} surfaceChrome="theme">
            <AnnotatorColorPanel
              color={style.color}
              size={style.size}
              showTextSize={showTextSize}
              onColor={(color) => annotator.setStyle({ color })}
              onSize={(size) => annotator.setStyle({ size })}
            />
          </FloatingOverlay>
        )}
      </Popover>
    </>
  );
}

/** Undo and Redo. A phone host stands them in its top capsule beside Done (MIS §3.7). */
export function AnnotatorHistoryButtons(props: Readonly<{ annotator: ImageAnnotator }>) {
  const { annotator } = props;
  const undoShortcut = useKeyboardShortcutLabel('annotation.undo');
  const redoShortcut = useKeyboardShortcutLabel('annotation.redo');
  const canUndo = useImageAnnotatorState(
    annotator,
    (state) => state.history.undo.length > 0,
  );
  const canRedo = useImageAnnotatorState(
    annotator,
    (state) => state.history.redo.length > 0,
  );
  return (
    <>
      <IconButton
        variant="plain"
        iconName="arrow-arc-left"
        accessibilityLabel={t('files.annotate.undo')}
        tooltip={withShortcut(t('files.annotate.undo'), undoShortcut)}
        tooltipPlacement="bottom"
        disabled={!canUndo}
        disabledReason={canUndo ? undefined : t('files.annotate.nothingToUndo')}
        onPress={() => annotator.undo()}
        testID="annotator-undo"
      />
      <IconButton
        variant="plain"
        iconName="arrow-arc-right"
        accessibilityLabel={t('files.annotate.redo')}
        tooltip={withShortcut(t('files.annotate.redo'), redoShortcut)}
        tooltipPlacement="bottom"
        disabled={!canRedo}
        disabledReason={canRedo ? undefined : t('files.annotate.nothingToRedo')}
        onPress={() => annotator.redo()}
        testID="annotator-redo"
      />
    </>
  );
}

function PaletteDivider() {
  const { theme } = useUnistyles();
  return (
    <View
      style={[styles.divider, { backgroundColor: theme.colors.border.surface }]}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s2,
    padding: theme.space.s4,
  },
  capsule: {
    padding: theme.space.s4,
  },
  slotHidden: {
    opacity: 0,
  },
  slotOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  paperCapsule: {
    borderRadius: 999,
    backgroundColor: theme.colors.surface.selectedUnfocused,
  },
  group: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s2,
  },
  divider: {
    width: StyleSheet.hairlineWidth * 2,
    height: theme.space.s16,
    marginHorizontal: theme.space.s4,
  },
  phoneRows: {
    gap: theme.space.s8,
    alignSelf: 'stretch',
  },
  phoneRowsHidden: {
    display: 'none',
  },
  phoneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'stretch',
    minHeight: PHONE_TOOL_SIZE + theme.space.s8 * 2,
    paddingHorizontal: theme.space.s8,
    overflow: 'hidden',
  },
  phoneTrack: {
    flex: 1,
  },
  phoneTools: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
  },
  stepGlyph: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The colour reads at the tools' weight: a full swatch inside a hairline ring, a paper gap between.
  swatchRing: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatchDot: {
    width: 17,
    height: 17,
    borderRadius: 8.5,
  },
}));
