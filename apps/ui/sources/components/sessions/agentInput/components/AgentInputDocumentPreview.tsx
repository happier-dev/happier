import * as React from 'react';
import { Platform, Pressable, useWindowDimensions, View } from 'react-native';

import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';
import { resolveAgentInputActionBarLayout, type AgentInputActionBarLayout } from '@/components/sessions/agentInput/layout/actionBarLogic';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { useLocalSetting, useSetting } from '@/sync/store/settingsReadHooks';
import { isPhoneHardware } from '@/utils/platform/isPhoneHardware';
import { getAgentInputFieldAccessoryPlacement } from '../controls/agentInputControlRegistry';
import { buildAgentInputPlacementDescriptors } from '../controls/buildAgentInputPlacementDescriptors';
import { resolveAgentInputControlLines, selectComposerPlacementPreferences } from '../controls/resolveAgentInputControlLines';
import { resolveRenderedExtraActionChipNodes } from '../controls/resolveRenderedExtraActionChipNodes';
import { t } from '@/text';

import type {
  AgentInputAttachmentsRowItem,
  AgentInputControlIntent,
  AgentInputExtraActionChip,
  AgentInputExtraActionChipRenderContext,
} from '../agentInputContracts';
import {
  AGENT_INPUT_CHIP_ICON_SIZE_PX,
  AGENT_INPUT_CHIP_ICON_STYLE,
} from '../definitions/agentInputChipIconMetrics';
import {
  AGENT_INPUT_ACTION_CHIP_ICON_ONLY_STYLE,
  AGENT_INPUT_ACTION_CHIP_PRESSED_STYLE,
  AGENT_INPUT_ACTION_CHIP_STYLE,
  resolveAgentInputActionChipTextStyle,
  resolveAgentInputPanelLayoutStyle,
} from './agentInputChromeStyles';
import { AgentInputAttachmentsRow } from './AgentInputAttachmentsRow';
import { AgentInputDocumentPreviewText } from './AgentInputDocumentPreviewText';
import { resolveAgentInputFieldAccessoryGeometry } from './AgentInputFieldAccessories';
import type {
  AgentInputDocumentPreviewReference,
  AgentInputDocumentPreviewSelection,
} from './agentInputDocumentPreviewTypes';

export type {
  AgentInputDocumentPreviewReference,
  AgentInputDocumentPreviewSelection,
} from './agentInputDocumentPreviewTypes';

const NO_ANCHOR: React.RefObject<View | null> = { current: null };
/** The field accessories' drawn circle; its target grows to the platform minimum around it. */
const ACCESSORY_VISUAL_SIZE = 24;

const styles = StyleSheet.create((theme) => ({
  /** The document card's own frame (`AgentInput` `container` + `containerDocument`). */
  container: {
    alignItems: 'center',
    width: '100%',
  },
  panel: {
    ...resolveAgentInputPanelLayoutStyle(theme),
    width: '100%',
  },
  /** The field's inset inside the panel: the input container plus its scroll section's bottom pad. */
  field: {
    paddingTop: 4,
    paddingBottom: 8,
    paddingHorizontal: theme.space.s8,
    minHeight: 40,
  },
  /** The field and its corner tools: positioned like the live `inputContainer`. */
  fieldFrame: {
    position: 'relative',
  },
  /** The chip line under the field (`actionButtonsContainer`). */
  footer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    columnGap: theme.space.s8,
  },
  chips: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: theme.space.s6,
    rowGap: 1,
  },
  chipsNarrow: {
    columnGap: theme.space.s4,
  },
  chipsScroll: {
    flexWrap: 'nowrap',
    overflow: 'hidden',
  },
  chipLine: {
    flexDirection: 'row',
    minWidth: 0,
    flexShrink: 1,
  },
  engineChip: {
    minWidth: 0,
    flexShrink: 1,
  },
  engineMark: {
    width: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  engineLabel: {
    minWidth: 0,
    flexShrink: 1,
  },
  /** The field's top-right corner, from the live composer's one geometry owner. */
  accessories: {
    position: 'absolute',
    zIndex: 2,
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  /** Each target hangs its circle 4 below the slot's top, as the live buttons do. */
  accessory: {
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingTop: 4,
  },
  accessoryCircle: {
    width: ACCESSORY_VISUAL_SIZE,
    height: ACCESSORY_VISUAL_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
}));

/**
 * A document composer as it reads before anyone edits it: the same panel, text, inline reference
 * chips and chip line as the live `AgentInput`, at static props, with none of its editor, menus,
 * dictation or store subscriptions. A long list of authored prompts mounts one of these per row and
 * the live composer only where the author is writing.
 *
 * Pressing the field (or focusing it from the keyboard) asks the owner for the live composer, with
 * the caret where the pointer went down. Contributed chips (Step options) keep working in place; the
 * composer's own chrome (+, engine, library, dictation) opens the live composer and forwards the
 * initiating intent to that control's existing owner after mount.
 */
export const AgentInputDocumentPreview = React.memo(
  function AgentInputDocumentPreview(
    props: Readonly<{
      value: string;
      references: readonly AgentInputDocumentPreviewReference[];
      placeholder: string;
      inputAccessibilityLabel?: string;
      /** The engine chip as the live row names it: the Agent's mark and the engine summary. */
      engine?: Readonly<{
        agentId: string | null;
        label: string;
        /** The selected engine option's own mark, when it has one (a profile, a role). */
        icon?: React.ReactNode;
      }> | null;
      /** Host and plugin chips, merged as the live row merges them. */
      extraActionChips?: ReadonlyArray<AgentInputExtraActionChip>;
      /** The document's attachments, drawn by the same tray the live row uses. */
      attachmentRowItems?: ReadonlyArray<AgentInputAttachmentsRowItem>;
      /** Shows the dictation accessory, as the live composer does for a written document. */
      dictation?: boolean;
      onActivate: (
        selection: AgentInputDocumentPreviewSelection | null,
        intent?: AgentInputControlIntent,
      ) => void;
      /** The host's chip layout when the setting is auto; the live composer reads the same request. */
      hostActionBarLayout?: AgentInputActionBarLayout;
      testID?: string;
    }>,
  ): React.ReactElement {
    const { theme } = useUnistyles();
    const tint = theme.colors.composer.chipTint;
    const chipDensity = useSetting('agentInputChipDensity');
    // The live row's own rhythm: a narrow window tightens the chip gap, and a scrolling bar never wraps.
    const windowWidth = useWindowDimensions().width;
    const actionBarLayout = resolveAgentInputActionBarLayout({
      configuredLayout: useSetting('agentInputActionBarLayout'),
      ...(props.hostActionBarLayout === undefined ? {} : { hostLayout: props.hostActionBarLayout }),
      platform: Platform.OS,
      isMobileLayout: isMobileLayoutWidth(windowWidth),
    });
    const narrow = windowWidth < 420;
    const voiceEnabled = useFeatureEnabled('voice');
    const showLabels = chipDensity !== 'icons';
    const textStyle = React.useMemo(
      () => resolveAgentInputActionChipTextStyle(theme),
      [theme],
    );
    const pointerSelection =
      React.useRef<AgentInputDocumentPreviewSelection | null>(null);
    const latestActivate = React.useRef(props.onActivate);
    latestActivate.current = props.onActivate;
    // A pointer opens the live composer on release, once the press is over, so the browser's own
    // click caret cannot land in the new field over the restored point; keyboard focus opens it at once.
    const pointerDown = React.useRef(false);
    const activate = React.useCallback(() => {
      const selection = pointerSelection.current;
      pointerSelection.current = null;
      pointerDown.current = false;
      latestActivate.current(selection);
    }, []);
    const activateOnFocus = React.useCallback(() => {
      if (!pointerDown.current) activate();
    }, [activate]);
    const notePointerDown = React.useCallback(() => {
      pointerDown.current = true;
    }, []);
    const clearPointerDown = React.useCallback(() => {
      pointerDown.current = false;
    }, []);
    const activateControl = React.useCallback((intent: AgentInputControlIntent) => {
      pointerSelection.current = null;
      pointerDown.current = false;
      latestActivate.current(null, intent);
    }, []);
    const recordPointerSelection = React.useCallback(
      (selection: AgentInputDocumentPreviewSelection | null) => {
        pointerDown.current = true;
        pointerSelection.current = selection;
      },
      [],
    );
    // A chip whose popover only the live composer can anchor opens the row and then that popover.
    const toggleCollapsedPopover = React.useCallback(
      (chipKey: string) => activateControl({ chipPopover: chipKey }),
      [activateControl],
    );
    const renderContext = React.useMemo<AgentInputExtraActionChipRenderContext>(
      () => ({
        chipStyle: (pressed: boolean) => [
          AGENT_INPUT_ACTION_CHIP_STYLE,
          showLabels ? null : AGENT_INPUT_ACTION_CHIP_ICON_ONLY_STYLE,
          pressed ? AGENT_INPUT_ACTION_CHIP_PRESSED_STYLE : null,
        ],
        showLabel: showLabels,
        iconColor: tint,
        textStyle,
        countTextStyle: { color: tint },
        popoverAnchorRef: NO_ANCHOR,
        toggleCollapsedPopover,
      }),
      [showLabels, textStyle, tint, toggleCollapsedPopover],
    );
    // The live accessories draw at their design square under every pointer (`AgentInputFieldAccessories`).
    const accessoryTarget = ACCESSORY_VISUAL_SIZE;
    const dictation = props.dictation === true && voiceEnabled;
    // The row's membership and order come from the composer's one placement owner, with the
    // author's saved placements: a chip moved to the overflow or hidden is not drawn here either.
    const placementPreferences = useLocalSetting(
      'navigationSurfacePlacementsV1',
      selectComposerPlacementPreferences,
    );
    const hasEngine = props.engine != null;
    const extraActionChips = props.extraActionChips;
    const resolvedControls = React.useMemo(
      () =>
        resolveAgentInputControlLines({
          controls: buildAgentInputPlacementDescriptors({
            coreControls: hasEngine ? [{ id: 'engine' as const }] : [],
            chips: extraActionChips ?? [],
            accessories: [
              getAgentInputFieldAccessoryPlacement('promptLibrary'),
              ...(dictation ? [getAgentInputFieldAccessoryPlacement('dictate')] : []),
            ],
            phone: isPhoneHardware(),
            newSession: true,
          }),
          preferences: placementPreferences,
        }),
      [dictation, extraActionChips, hasEngine, placementPreferences],
    );
    const rowIds = [...resolvedControls.primary, ...resolvedControls.secondary];
    const { extraControlNodesById } = resolveRenderedExtraActionChipNodes({
      chips: extraActionChips ?? [],
      placementIds: rowIds,
      renderContext,
      autoHideRenderContext: renderContext,
    });
    const control = (key: 'actionMenu' | 'engine', node: React.ReactNode) => (
      <Pressable
        key={key}
        testID={`agent-input-document-preview-${key}-control`}
        accessibilityRole="button"
        accessibilityLabel={key === 'engine' ? props.engine?.label : t('agentInput.actionMenu.title')}
        accessible
        focusable
        onPress={() => activateControl(key)}
        style={styles.chipLine}
      >
        {node}
      </Pressable>
    );
    const engineChip = props.engine ? (
      <View
        testID="agent-input-document-preview-engine"
        style={[
          AGENT_INPUT_ACTION_CHIP_STYLE,
          showLabels ? null : AGENT_INPUT_ACTION_CHIP_ICON_ONLY_STYLE,
          styles.engineChip,
        ]}
      >
        <View style={styles.engineMark}>
          {props.engine.icon ?? (
            <AgentIcon agentId={props.engine.agentId} size={16} color={tint} />
          )}
        </View>
        {showLabels ? (
          <Text numberOfLines={1} style={[textStyle, styles.engineLabel]}>
            {props.engine.label}
          </Text>
        ) : null}
      </View>
    ) : null;
    const accessoryNodes = resolvedControls.accessories.map((id) =>
      id === 'promptLibrary' ? (
        <Pressable
          key={id}
          testID="agent-input-document-preview-prompt-library"
          accessibilityRole="button"
          accessibilityLabel={t('agentInput.promptPicker.open')}
          accessible
          focusable
          onPress={() => activateControl('promptLibrary')}
          style={[styles.accessory, { width: accessoryTarget, height: accessoryTarget }]}
        >
          <View style={styles.accessoryCircle}>
            <Icon name="book-open" size={16} color={theme.colors.button.secondary.tint} />
          </View>
        </Pressable>
      ) : id === 'dictate' ? (
        <Pressable
          key={id}
          testID="agent-input-document-preview-dictate"
          accessibilityRole="button"
          accessibilityLabel={t('voiceAssistant.startDictation')}
          accessible
          focusable
          onPress={() => activateControl('dictate')}
          style={[styles.accessory, { width: accessoryTarget, height: accessoryTarget }]}
        >
          <View style={styles.accessoryCircle}>
            <Icon name="microphone" size={16} color={theme.colors.button.secondary.tint} />
          </View>
        </Pressable>
      ) : null,
    );

    // The corner's width follows the tools actually drawn, as the live composer's does.
    const fieldGeometry = resolveAgentInputFieldAccessoryGeometry({
      library: accessoryNodes.length > 0,
      accessory: accessoryNodes.length > 1,
      belowToggle: false,
    });

    return (
      <View
        testID={props.testID ?? 'agent-input-document-preview'}
        style={styles.container}
      >
        <GlassSurface
          testID="agent-input-document-preview-surface"
          surfaceGroup="card"
          nested
          solidColor={theme.colors.input.background}
          finishRole="composer"
          style={styles.panel}
        >
          {props.attachmentRowItems !== undefined &&
          props.attachmentRowItems.length > 0 ? (
            <View testID="agent-input-document-preview-attachments">
              <AgentInputAttachmentsRow
                items={props.attachmentRowItems}
                onRequestComposerFocus={activate}
              />
            </View>
          ) : null}
          <View style={styles.fieldFrame}>
          <Pressable
            testID="agent-input-document-preview-field"
            accessibilityRole="button"
            accessibilityLabel={
              props.inputAccessibilityLabel ??
              (props.value || props.placeholder)
            }
            accessibilityHint={t('common.edit')}
            onPress={activate}
            onFocus={activateOnFocus}
            onBlur={clearPointerDown}
            onPressIn={notePointerDown}
            // DOM pointerdown precedes the focus a press causes; the responder's press-in may not.
            {...({ onPointerDown: notePointerDown } as object)}
            style={[styles.field, fieldGeometry.paddingRight === undefined ? null : { paddingRight: theme.space.s8 + fieldGeometry.paddingRight }]}
          >
            <AgentInputDocumentPreviewText
              value={props.value}
              references={props.references}
              placeholder={props.placeholder}
              onPointerSelection={recordPointerSelection}
            />
          </Pressable>
          {accessoryNodes.length > 0 ? (
            <View
              testID="agent-input-document-preview-tools"
              style={[styles.accessories, { width: fieldGeometry.width, height: fieldGeometry.targetSize, top: fieldGeometry.top, right: fieldGeometry.right }]}
            >
              {accessoryNodes}
            </View>
          ) : null}
          </View>
          <View testID="agent-input-document-preview-footer" style={styles.footer}>
            <View
              style={[
                styles.chips,
                narrow ? styles.chipsNarrow : null,
                actionBarLayout === 'scroll' ? styles.chipsScroll : null,
              ]}
            >
              {control(
                'actionMenu',
                <View style={[AGENT_INPUT_ACTION_CHIP_STYLE, AGENT_INPUT_ACTION_CHIP_ICON_ONLY_STYLE]}>
                  <Icon
                    name="plus"
                    size={AGENT_INPUT_CHIP_ICON_SIZE_PX}
                    color={tint}
                    style={AGENT_INPUT_CHIP_ICON_STYLE}
                  />
                </View>,
              )}
              {rowIds.map((id) =>
                id === 'engine'
                  ? engineChip && control(id, engineChip)
                  : (extraControlNodesById[id] ?? []).map((node, index) => (
                      <React.Fragment key={`${id}:${index}`}>{node}</React.Fragment>
                    )),
              )}
            </View>
          </View>
        </GlassSurface>
      </View>
    );
  },
);
