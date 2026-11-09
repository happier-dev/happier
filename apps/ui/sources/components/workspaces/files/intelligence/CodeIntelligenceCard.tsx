import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import type { LanguageIntelligenceDiagnostic } from '@happier-dev/protocol/machines/languageIntelligence';

import type { Rect } from '@/components/ui/code/editor/codeEditorTypes';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { Icon } from '@/components/ui/icons/Icon';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { SimpleSyntaxHighlighter } from '@/components/ui/media/SimpleSyntaxHighlighter';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import type { CodeIdentifier } from '@/sync/domains/workspaces/languageIntelligence/codeIdentifiers';
import { t } from '@/text';

import type {
  CodeHoverContent,
  LanguageStateNote,
} from './codeIntelligencePresentation';
import { CodeIntelligencePaneTab } from './CodeIntelligencePaneTab';
import { useFilePageBox } from './filePageBox';
import {
  CodeReferencesList,
  type CodeReferenceRow,
} from './CodeReferencesList';

/** The lab's card (LS1 `rv-hover`) is 440 wide; a longer signature widens it up to the cap before it wraps. */
const CARD_MIN_WIDTH = 440;
/** The card's own width before a signature widens it; other cards at a name (rename, fixes) share it. */
export const CODE_CARD_WIDTH = CARD_MIN_WIDTH;
const CARD_MAX_WIDTH = 600;
const CARD_MAX_HEIGHT = 420;
/** Signature type: the mono meta pair (lab `.sig` 12/19). IBM Plex Mono advances 0.6 em per character. */
const SIGNATURE_FONT_SIZE = 12;
const SIGNATURE_LINE_HEIGHT = 19;
const MONO_ADVANCE_EM = 0.6;

/** Inter's average advance for meta text, for the footer's estimate (labels truncate if it is short). */
const META_ADVANCE_PX = 12 * 0.56;
const MICRO_MONO_ADVANCE_PX = 11 * MONO_ADVANCE_EM;

/**
 * One width for the card, decided before it opens (the popover is as wide as its cap): wide enough for
 * the signature's longest line and for the footer (two actions with their keys and "TypeScript ·
 * {machine}") on one line each, never narrower than the lab's card or wider than the cap.
 */
function resolveCardWidth(
  input: Readonly<{
    signature: string | null;
    actions: readonly Readonly<{ label: string; shortcut?: string }>[];
    sourceLabel: string | null;
    space: Readonly<{ s4: number; s6: number; s8: number; s12: number }>;
  }>,
): number {
  const { space } = input;
  const longest = input.signature
    ? Math.max(...input.signature.split('\n').map((line) => line.length))
    : 0;
  const signature =
    Math.ceil(longest * SIGNATURE_FONT_SIZE * MONO_ADVANCE_EM) + space.s12 * 2 + 2;
  const actions = input.actions.reduce(
    (width, action) =>
      width +
      space.s6 * 2 +
      action.label.length * META_ADVANCE_PX +
      (action.shortcut ? space.s6 + action.shortcut.length * MICRO_MONO_ADVANCE_PX : 0),
    0,
  );
  const footer = Math.ceil(
    space.s6 * 2 +
      actions +
      space.s4 * (input.actions.length + 1) +
      space.s8 +
      (input.sourceLabel?.length ?? 0) * META_ADVANCE_PX,
  );
  return Math.max(CARD_MIN_WIDTH, Math.min(CARD_MAX_WIDTH, Math.max(signature, footer)));
}

export type CodeIntelligenceCardModel = Readonly<{
  /** The name the answer is about, and the line's other names (phones: a near miss is one tap). */
  name: CodeIdentifier | null;
  names: readonly CodeIdentifier[];
  hover: CodeHoverContent | null;
  /** The problem under the pointer leads the card (LS4). */
  diagnostic: LanguageIntelligenceDiagnostic | null;
  /** The definition lies outside the workspace (OD-7): its absolute path, never opened. */
  outsidePath: string | null;
  /** One quiet line while the server starts or loads the project. */
  progress: LanguageStateNote | null;
  searching: boolean;
  /** "TypeScript · NLDW3"; absent when no server answered (name search). */
  sourceLabel: string | null;
  /** Phones: references grow out of the card in the same sheet (L3 `ls2-R`). */
  references: Readonly<{
    rows: readonly CodeReferenceRow[];
    textMatches: boolean;
    partial: boolean;
    searching: boolean;
  }> | null;
}>;

export type CodeIntelligenceCardProps = Readonly<{
  open: boolean;
  anchor: Rect | null;
  model: CodeIntelligenceCardModel;
  onRequestClose: () => void;
  onDefinition: () => void;
  onReferences: () => void;
  onTypeDefinition?: () => void;
  onImplementation?: () => void;
  onCopyName: () => void;
  onCopyPath: (path: string) => void;
  onChooseName: (name: CodeIdentifier) => void;
  onOpenReference: (row: CodeReferenceRow) => void;
  /** The shared References / Calls view, mounted only in the phone sheet. */
  referencesContent?: React.ReactNode;
  /** Quick fixes for the problem the card leads with (Alt+Enter). */
  onQuickFix?: () => void;
  /** Phones: rename the name from the sheet (desktop uses F2 and the ⋯ menu). */
  onRename?: () => void;
  /** The pointer is over the card: a hover card stays while it is read. */
  onHoverChange?: (hovered: boolean) => void;
}>;

/**
 * The language answer about one name (LS1 `rv-hover`, LS2 phone sheet): its signature, its
 * documentation, the problem on it, and the two ways on (definition, references). On desktop it is a
 * non-modal card at the name; on a phone the shared sheet, with the line's other names as chips.
 */
export function CodeIntelligenceCard(
  props: CodeIntelligenceCardProps,
): React.ReactElement | null {
  const { theme } = useUnistyles();
  const definitionKey = useKeyboardShortcutLabel('code.goToDefinition');
  const referencesKey = useKeyboardShortcutLabel('code.findReferences');
  const quickFixKey = useKeyboardShortcutLabel('code.quickFix');
  const pageBox = useFilePageBox();
  const anchor = props.anchor;
  const popoverAnchor = React.useMemo(
    () =>
      anchor
        ? {
            kind: 'rect' as const,
            rect: {
              left: anchor.x,
              top: anchor.y,
              width: Math.max(1, anchor.width),
              height: Math.max(1, anchor.height),
            },
            coordinateSpace: 'window' as const,
          }
        : null,
    [anchor?.x, anchor?.y, anchor?.width, anchor?.height],
  );
  if (!props.open) return null;
  const webKeys = Platform.OS === 'web';
  const cardWidth = resolveCardWidth({
    signature: props.model.hover?.signature?.code ?? null,
    actions: [
      ...(props.model.diagnostic && props.onQuickFix
        ? [{ label: t('files.pane.intelligence.fix'), ...(webKeys && quickFixKey ? { shortcut: quickFixKey } : {}) }]
        : []),
      ...(props.model.outsidePath
        ? []
        : [{ label: t('files.pane.intelligence.goToDefinition'), ...(webKeys && definitionKey ? { shortcut: definitionKey } : {}) }]),
      { label: t('files.pane.intelligence.findReferences'), ...(webKeys && referencesKey ? { shortcut: referencesKey } : {}) },
      ...(props.onTypeDefinition ? [{ label: t('files.pane.menu.goToTypeDefinition') }] : []),
      ...(props.onImplementation ? [{ label: t('files.pane.menu.goToImplementation') }] : []),
    ],
    sourceLabel: props.model.sourceLabel,
    space: theme.space,
  });
  return (
    <>
    {pageBox.box}
    <Popover
      open
      anchor={popoverAnchor ?? undefined}
      backdrop={false}
      boundaryRef={null}
      horizontalBoundaryRef={pageBox.ref}
      onRequestClose={props.onRequestClose}
      phonePresentation="sheet"
      sheetHeader="none"
      sheetMaterial="solid"
      // The tapped line stays readable above the sheet (lab LS2 T): no scrim over the code.
      sheetBackdrop="none"
      accessibilityLabel={
        props.model.name?.symbol ?? t('files.pane.intelligence.cardLabel')
      }
      portal={{
        web: true,
        native: true,
        matchAnchorWidth: false,
        anchorAlign: 'start',
      }}
      placement="bottom"
      flip
      gap={4}
      minWidth={0}
      maxWidthCap={cardWidth}
      maxHeightCap={CARD_MAX_HEIGHT}
    >
      {({ presentation, maxHeight, maxWidth }) =>
        presentation === 'sheet' ? (
          <CodeIntelligenceSheetContent {...props} />
        ) : (
          <FloatingOverlay
            maxHeight={Math.min(maxHeight, CARD_MAX_HEIGHT)}
            // A card at a name reads over dense code: the panel coat keeps the lines under it from
            // showing through its text (the rename and fix card at a name carries the same coat).
            role="panel"
            edgeFades={{ top: true, bottom: true }}
          >
            <View
              testID="code-hover-card"
              accessibilityRole={Platform.OS === 'web' ? undefined : 'summary'}
              style={{ width: Math.min(cardWidth, maxWidth) }}
              {...(Platform.OS === 'web'
                ? {
                    onPointerEnter: () => props.onHoverChange?.(true),
                    onPointerLeave: () => props.onHoverChange?.(false),
                  }
                : {})}
            >
              <CodeIntelligenceAnswer
                model={props.model}
                onCopyPath={props.onCopyPath}
              />
              <CodeIntelligenceFooter
                model={props.model}
                onDefinition={props.onDefinition}
                onReferences={props.onReferences}
                onTypeDefinition={props.onTypeDefinition}
                onImplementation={props.onImplementation}
                {...(props.onQuickFix ? { onQuickFix: props.onQuickFix } : {})}
              />
            </View>
          </FloatingOverlay>
        )
      }
    </Popover>
    </>
  );
}

function CodeIntelligenceAnswer(
  props: Readonly<{
    model: CodeIntelligenceCardModel;
    onCopyPath: (path: string) => void;
    sheet?: boolean;
  }>,
) {
  const { theme } = useUnistyles();
  const { model } = props;
  const hasAnswer = Boolean(
    model.diagnostic || model.hover || model.outsidePath,
  );
  return (
    <>
      {model.diagnostic ? (
        <View
          style={[styles.block, styles.diagnostic]}
          testID="code-hover-card-diagnostic"
        >
          <Icon
            name="x-circle"
            size={14}
            color={
              model.diagnostic.severity === 'error'
                ? theme.colors.state.danger.foreground
                : theme.colors.state.warning.foreground
            }
          />
          <Text variant="body" style={styles.diagnosticText}>
            {model.diagnostic.message}
          </Text>
        </View>
      ) : null}
      {model.hover?.signature ? (
        <View
          style={[
            styles.block,
            props.sheet ? styles.sheetSignature : styles.signature,
            model.diagnostic ? styles.divided : null,
          ]}
          testID="code-hover-card-signature"
        >
          <SimpleSyntaxHighlighter
            code={model.hover.signature.code}
            language={model.hover.signature.language ?? 'typescript'}
            selectable
            wrap
            fontSize={SIGNATURE_FONT_SIZE}
            lineHeight={SIGNATURE_LINE_HEIGHT}
          />
        </View>
      ) : null}
      {model.hover?.documentation ? (
        <View
          style={[
            styles.block,
            !props.sheet && (model.hover.signature || model.diagnostic)
              ? styles.divided
              : null,
          ]}
        >
          {/* Servers write their documentation in Markdown (bold, `code`, JSDoc tags): the canonical renderer draws it at the card's quiet meta step. */}
          <MarkdownView markdown={model.hover.documentation} selectable textStyle={styles.documentation} />
        </View>
      ) : null}
      {model.outsidePath ? (
        <View
          style={[
            styles.block,
            hasAnswer && (model.hover || model.diagnostic)
              ? styles.divided
              : null,
          ]}
          testID="code-hover-card-outside"
        >
          <Text variant="label" emphasis="medium" style={styles.primaryText}>
            {t('files.pane.intelligence.definedOutside')}
          </Text>
          <View style={styles.pathRow}>
            <Text
              variant="meta"
              numberOfLines={2}
              selectable
              style={styles.path}
            >
              {model.outsidePath}
            </Text>
            <HappierPressable
              accessibilityRole="button"
              testID="code-hover-card-copy-path"
              onPress={() => props.onCopyPath(model.outsidePath!)}
              style={({ hovered, pressed }) => [
                styles.inlineAction,
                pressed ? styles.pressed : hovered ? styles.hovered : null,
              ]}
            >
              <Text variant="label" emphasis="medium" style={styles.link}>
                {t('files.pane.intelligence.copy')}
              </Text>
            </HappierPressable>
          </View>
        </View>
      ) : null}
      {!hasAnswer && model.progress ? (
        <View
          style={[styles.block, styles.progress]}
          testID="code-hover-card-progress"
        >
          <Text variant="body" style={styles.secondaryText}>
            {model.progress.text}
          </Text>
          {model.progress.detail ? (
            <Text variant="meta" style={styles.tertiaryText}>
              {model.progress.detail}
            </Text>
          ) : null}
        </View>
      ) : null}
      {!hasAnswer && !model.progress && model.searching ? (
        <View style={styles.block}>
          <Text variant="meta" style={styles.tertiaryText}>
            {t('files.pane.intelligence.lookingUp')}
          </Text>
        </View>
      ) : null}
      {/* A command or a tap always answers: with nothing to say, it says so once instead of an empty card. */}
      {!hasAnswer && !model.progress && !model.searching ? (
        <View style={styles.block} testID="code-hover-card-empty">
          <Text variant="meta" style={styles.tertiaryText}>
            {t('files.pane.intelligence.noInfo')}
          </Text>
        </View>
      ) : null}
    </>
  );
}

function CodeIntelligenceFooter(
  props: Readonly<{
    model: CodeIntelligenceCardModel;
    onDefinition: () => void;
    onReferences: () => void;
    onTypeDefinition?: () => void;
    onImplementation?: () => void;
    onQuickFix?: () => void;
  }>,
) {
  const definitionKey = useKeyboardShortcutLabel('code.goToDefinition');
  const referencesKey = useKeyboardShortcutLabel('code.findReferences');
  const quickFixKey = useKeyboardShortcutLabel('code.quickFix');
  // Without a name there is nothing to look up: no actions that would do nothing.
  const named = Boolean(props.model.name);
  const fixable = Boolean(props.model.diagnostic && props.onQuickFix);
  if (!named && !fixable) return null;
  return (
    <View
      style={[
        styles.footer,
        props.model.hover || props.model.diagnostic || props.model.outsidePath
          ? styles.divided
          : null,
      ]}
    >
      {props.model.diagnostic && props.onQuickFix ? (
        <FooterAction
          label={t('files.pane.intelligence.fix')}
          shortcut={quickFixKey}
          onPress={props.onQuickFix}
          testID="code-hover-card-fix"
        />
      ) : null}
      {props.model.outsidePath || !named ? null : (
        <FooterAction
          label={t('files.pane.intelligence.goToDefinition')}
          shortcut={definitionKey}
          onPress={props.onDefinition}
          testID="code-hover-card-definition"
        />
      )}
      {named ? (
        <FooterAction
          label={t('files.pane.intelligence.findReferences')}
          shortcut={referencesKey}
          onPress={props.onReferences}
          testID="code-hover-card-references"
        />
      ) : null}
      {named && props.onTypeDefinition ? <FooterAction label={t('files.pane.menu.goToTypeDefinition')} onPress={props.onTypeDefinition} testID="code-hover-card-type-definition" /> : null}
      {named && props.onImplementation ? <FooterAction label={t('files.pane.menu.goToImplementation')} onPress={props.onImplementation} testID="code-hover-card-implementation" /> : null}
      <View style={styles.footerSpacer} />
      {props.model.sourceLabel ? (
        <Text variant="meta" numberOfLines={1} style={styles.tertiaryText}>
          {props.model.sourceLabel}
        </Text>
      ) : null}
    </View>
  );
}

function FooterAction(
  props: Readonly<{
    label: string;
    shortcut?: string;
    onPress: () => void;
    testID: string;
  }>,
) {
  return (
    <HappierPressable
      accessibilityRole="button"
      testID={props.testID}
      onPress={props.onPress}
      style={({ hovered, pressed }) => [
        styles.inlineAction,
        pressed ? styles.pressed : hovered ? styles.hovered : null,
      ]}
    >
      <Text variant="meta" style={styles.link}>
        {props.label}
      </Text>
      {props.shortcut && Platform.OS === 'web' ? (
        <Text variant="micro" style={styles.shortcut}>
          {props.shortcut}
        </Text>
      ) : null}
    </HappierPressable>
  );
}

function CodeIntelligenceSheetContent(props: CodeIntelligenceCardProps) {
  const { model } = props;
  const referencesKey = model.references?.searching
    ? null
    : model.references?.rows.length;
  return (
    <View style={styles.sheet} testID="code-name-sheet">
      {model.names.length > 1 ? (
        <View
          style={styles.chips}
          accessibilityRole="radiogroup"
          accessibilityLabel={t('files.pane.intelligence.namesOnLine')}
        >
          {model.names.map((name) => {
            const selected =
              model.name?.startCharacter === name.startCharacter &&
              model.name.symbol === name.symbol;
            return (
              <HappierPressable
                key={`${name.startCharacter}:${name.symbol}`}
                accessibilityRole="radio"
                selected={selected}
                testID={`code-name-sheet-chip-${name.symbol}`}
                onPress={() => props.onChooseName(name)}
                style={({ pressed }) => [
                  styles.chip,
                  selected ? styles.chipSelected : null,
                  pressed ? styles.pressed : null,
                ]}
              >
                <Text
                  variant="label"
                  numberOfLines={1}
                  style={[
                    styles.chipText,
                    selected ? styles.primaryText : null,
                  ]}
                >
                  {name.symbol}
                </Text>
              </HappierPressable>
            );
          })}
        </View>
      ) : null}
      {model.references ? (
        props.referencesContent ?? (
          <CodeReferencesList
            rows={model.references.rows}
            textMatches={model.references.textMatches}
            partial={model.references.partial}
            searching={model.references.searching}
            progress={model.progress}
            onOpen={props.onOpenReference}
          />
        )
      ) : (
        <>
          <CodeIntelligenceAnswer
            model={model}
            onCopyPath={props.onCopyPath}
            sheet
          />
          <SelectionTiles
            variant="action"
            accessibilityLabel={model.name?.symbol}
            testIdPrefix="code-name-sheet-action"
            options={[
              ...(model.diagnostic && props.onQuickFix
                ? [{ id: 'fix', title: t('files.pane.intelligence.fix'), icon: 'lightbulb' as const }]
                : []),
              {
                id: 'definition',
                title: t('files.pane.intelligence.definition'),
                subtitle: model.name?.symbol,
                icon: 'arrow-right',
              },
              {
                id: 'references',
                title: t('files.pane.intelligence.references'),
                ...(referencesKey ? { subtitle: String(referencesKey) } : {}),
                icon: 'list',
              },
              { id: 'copy', title: t('files.pane.intelligence.copy'), icon: 'copy' },
              ...(props.onTypeDefinition ? [{ id: 'typeDefinition', title: t('files.pane.menu.goToTypeDefinition'), icon: 'arrow-right' as const }] : []),
              ...(props.onImplementation ? [{ id: 'implementation', title: t('files.pane.menu.goToImplementation'), icon: 'arrow-right' as const }] : []),
              ...(props.onRename && model.name
                ? [{ id: 'rename', title: t('files.pane.intelligence.renameTitle'), icon: 'pencil-simple' as const }]
                : []),
            ]}
            onPress={(id) =>
              id === 'typeDefinition' ? props.onTypeDefinition?.() : id === 'implementation' ? props.onImplementation?.() : id === 'fix'
                ? props.onQuickFix?.()
                : id === 'rename'
                  ? props.onRename?.()
                : id === 'definition'
                ? props.onDefinition()
                : id === 'references'
                  ? props.onReferences()
                  : props.onCopyName()
            }
          />
          {model.sourceLabel ? (
            <Text
              variant="meta"
              style={[styles.tertiaryText, styles.sheetSource]}
            >
              {model.sourceLabel}
            </Text>
          ) : null}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  problemsSheet: {
    minHeight: 280,
  },
  block: {
    paddingHorizontal: theme.space.s12,
    paddingVertical: theme.space.s10,
    gap: theme.space.s4,
  },
  divided: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.subtle,
  },
  signature: {
    paddingVertical: theme.space.s10,
  },
  sheetSignature: {
    backgroundColor: theme.colors.surface.sectionTint,
    borderRadius: theme.borderRadius.md,
    marginHorizontal: theme.space.s12,
    paddingVertical: theme.space.s10,
  },
  diagnostic: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s8,
  },
  diagnosticText: {
    flex: 1,
    color: theme.colors.text.primary,
  },
  documentation: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
  progress: {
    paddingVertical: theme.space.s10,
  },
  primaryText: {
    color: theme.colors.text.primary,
  },
  secondaryText: {
    color: theme.colors.text.secondary,
  },
  tertiaryText: {
    color: theme.colors.text.tertiary,
  },
  pathRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  path: {
    ...Typography.mono(),
    flex: 1,
    color: theme.colors.text.secondary,
  },
  // The actions read left to right, the answering server sits at the end; a card held narrower than its
  // actions (a File page beside other panes) wraps them onto a second line instead of cutting the last.
  footer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.space.s4,
    paddingHorizontal: theme.space.s6,
    paddingVertical: theme.space.s4,
  },
  footerSpacer: {
    flex: 1,
    minWidth: theme.space.s8,
  },
  inlineAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    paddingHorizontal: theme.space.s6,
    paddingVertical: theme.space.s4,
    borderRadius: theme.borderRadius.sm,
  },
  hovered: {
    backgroundColor: theme.colors.surface.pressed,
  },
  pressed: {
    opacity: 0.7,
  },
  link: {
    color: theme.colors.text.link,
  },
  shortcut: {
    ...Typography.mono(),
    color: theme.colors.text.tertiary,
  },
  sheet: {
    gap: theme.space.s12,
    paddingTop: theme.space.s4,
    paddingBottom: theme.space.s12,
  },
  sheetSource: {
    paddingHorizontal: theme.space.s16,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s12,
  },
  chip: {
    paddingHorizontal: theme.space.s12,
    paddingVertical: theme.space.s6,
    borderRadius: 999,
    backgroundColor: theme.colors.surface.sectionTint,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'transparent',
  },
  chipSelected: {
    borderColor: theme.colors.border.strong,
    backgroundColor: theme.colors.surface.selected,
  },
  chipText: {
    ...Typography.mono(),
    color: theme.colors.text.secondary,
  },
}));

/** Phones: Problems as a sheet over the File page, opened from the "3 problems" fact (L3 `ls2-P`). */
export function CodeProblemsSheet(props: Readonly<{ scopeId: string; onRequestClose: () => void }>): React.ReactElement {
  return (
    <Popover
      open
      backdrop={false}
      boundaryRef={null}
      onRequestClose={props.onRequestClose}
      phonePresentation="sheet"
      sheetMaterial="solid"
      accessibilityLabel={t('files.pane.intelligence.problemsTitle')}
      portal={{ web: true, native: true, matchAnchorWidth: false }}
      placement="bottom"
    >
      {() => (
        <View style={styles.problemsSheet} testID="code-problems-sheet">
          <CodeIntelligencePaneTab scopeId={props.scopeId} kind="problems" active />
        </View>
      )}
    </Popover>
  );
}
