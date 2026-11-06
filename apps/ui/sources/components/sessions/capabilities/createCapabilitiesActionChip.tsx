import { getCapabilitiesActionChipPlacement } from './capabilitiesActionChipPlacement';
import * as React from 'react';
import { Pressable, View, type LayoutChangeEvent } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { AgentInputPopoverContent } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { AgentInputChipLabel } from '@/components/sessions/agentInput/components/AgentInputChipLabel';
import {
  AGENT_INPUT_CHIP_ICON_SIZE_PX,
  AGENT_INPUT_CHIP_ICON_STYLE,
  AGENT_INPUT_MENU_ICON_SIZE_PX,
} from '@/components/sessions/agentInput/definitions/agentInputChipIconMetrics';
import { Icon } from '@/components/ui/icons/Icon';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { t } from '@/text';

export const SESSION_CAPABILITIES_CHIP_KEY = 'session-capabilities';
/** The lab popover's width: the menu grid (name | scope | action) stays in its wide form on desktop. */
export const SESSION_CAPABILITIES_POPOVER_WIDTH_PX = 520;
/** The popover caps at this share of the window; its body scrolls under the fixed add field and footer (lab §12). */
export const SESSION_CAPABILITIES_POPOVER_HEIGHT_RATIO = 0.7;
const CHIP_GLYPH = 'stack' as const;

function AttentionDot() {
  const { theme } = useUnistyles();
  return <StatusDot color={theme.colors.state.warning.foreground} size={6} />;
}

/**
 * The composer chip for "This session gets" (draft, existing session, workflow and trigger authoring):
 * "6 skills · 7 MCP" with the amber dot when a row needs the person, opening the shared content popover
 * (a bottom sheet on a phone). The content is `SessionCapabilitiesContent`, rendered by the caller.
 */
export function createCapabilitiesActionChip(
  params: Readonly<{
    label: string;
    placementId?: string;
    attention: boolean;
    stabilityKey: string;
    popoverContent: AgentInputPopoverContent;
    /** The one demand signal: hover, press-in, focus and overflow all route through it. */
    onIntent?: () => void;
    maxHeightCap?: number;
    /** The route asked for the sheet (`?capabilities=open`, PD13): the chip opens it once, then hands back. */
    openRequest?: Readonly<{ consume: () => void }> | null;
  }>,
): AgentInputExtraActionChip {
  const title = t('capabilities.session.sheet.title');
  return {
    key: SESSION_CAPABILITIES_CHIP_KEY,
    onIntent: params.onIntent,
    stabilityKey: `${params.stabilityKey}:${params.label}:${params.attention ? 1 : 0}:${params.openRequest ? 'open' : ''}`,
    controlId: 'capabilities',
    placement: { ...getCapabilitiesActionChipPlacement(), ...(params.placementId ? { id: params.placementId } : {}) },
    collapsedContentPopover: {
      title,
      label: params.label,
      icon: (tint: string) =>
        normalizeNodeForView(
          <Icon
            name={CHIP_GLYPH}
            size={AGENT_INPUT_MENU_ICON_SIZE_PX}
            color={tint}
          />,
        ),
      renderContent: params.popoverContent,
      header: { title },
      phonePresentation: 'sheet',
      // The content scrolls its own body under a fixed add field and footer.
      scrollEnabled: false,
      keyboardShouldPersistTaps: 'handled',
      maxHeightCap: params.maxHeightCap,
      maxWidthCap: SESSION_CAPABILITIES_POPOVER_WIDTH_PX,
    },
    render: ({
      chipStyle,
      iconColor,
      showLabel,
      textStyle,
      countTextStyle,
      chipAnchorRef,
      toggleCollapsedPopover,
    }) => (
      <CapabilitiesChipPressable
        openRequest={params.openRequest ?? null}
        open={() => {
          // A route open is an entry like a press: it demands the preview through the one intent signal.
          params.onIntent?.();
          toggleCollapsedPopover?.(SESSION_CAPABILITIES_CHIP_KEY);
        }}
        ref={chipAnchorRef}
        testID="session-capabilities-chip"
        accessibilityRole="button"
        accessibilityLabel={`${title}: ${params.label}`}
        onPress={() => toggleCollapsedPopover?.(SESSION_CAPABILITIES_CHIP_KEY)}
        onHoverIn={params.onIntent}
        onPressIn={params.onIntent}
        onFocus={params.onIntent}
        hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
        style={(pressed) => chipStyle(pressed.pressed)}
      >
        {normalizeNodeForView(
          <Icon
            name={CHIP_GLYPH}
            size={AGENT_INPUT_CHIP_ICON_SIZE_PX}
            color={iconColor}
            style={AGENT_INPUT_CHIP_ICON_STYLE}
          />,
        )}
        {showLabel ? (
          <ReservedChipLabel
            label={params.label}
            textStyle={[textStyle, { fontVariant: ['tabular-nums'] }]}
            countTextStyle={countTextStyle}
          />
        ) : null}
        {params.attention ? (
          <View testID="session-capabilities-chip:attention">
            <AttentionDot />
          </View>
        ) : null}
      </CapabilitiesChipPressable>
    ),
  };
}

/**
 * The label holds the width of a counted label ("88 skills · 88 MCP", tabular digits), so the chip keeps its width
 * while its counts load and as they change: the composer's chip row does not shift and the popover anchored to the
 * chip does not drift. The reference is measured, never drawn.
 */
function ReservedChipLabel(props: Readonly<{ label: string; textStyle: React.ComponentProps<typeof AgentInputChipLabel>['textStyle']; countTextStyle: React.ComponentProps<typeof AgentInputChipLabel>['countTextStyle'] }>) {
  const [reservedWidth, setReservedWidth] = React.useState(0);
  const onLayout = React.useCallback((event: LayoutChangeEvent) => {
    setReservedWidth(Math.ceil(event.nativeEvent.layout.width));
  }, []);
  return (
    <View style={reservedWidth > 0 ? { minWidth: reservedWidth } : undefined} testID="session-capabilities-chip:label">
      <AgentInputChipLabel label={props.label} textStyle={props.textStyle} countTextStyle={props.countTextStyle} />
      <View
        aria-hidden
        pointerEvents="none"
        onLayout={onLayout}
        testID="session-capabilities-chip:reserve"
        style={{ position: 'absolute', opacity: 0 }}
      >
        <AgentInputChipLabel label={t('capabilities.session.counts', { skills: 88, mcp: 88 })} textStyle={props.textStyle} countTextStyle={props.countTextStyle} />
      </View>
    </View>
  );
}

/** The chip's pressable; on mount with a route request it opens its own popover once and consumes the request. */
const CapabilitiesChipPressable = React.forwardRef<
  View,
  React.ComponentProps<typeof Pressable> &
    Readonly<{
      openRequest: Readonly<{ consume: () => void }> | null;
      open: () => void;
    }>
>(function CapabilitiesChipPressable({ openRequest, open, ...pressable }, ref) {
  const openRef = React.useRef(open);
  openRef.current = open;
  React.useEffect(() => {
    if (!openRequest) return;
    openRef.current();
    openRequest.consume();
  }, [openRequest]);
  return <Pressable ref={ref} {...pressable} />;
});
