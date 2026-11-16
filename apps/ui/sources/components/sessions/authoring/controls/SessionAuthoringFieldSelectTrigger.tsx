import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import {
  HAPPIER_FOCUS_RING_DELEGATED_STYLE,
  HappierPressable,
} from '@happier-dev/plugin-ui/presentation';

import { renderDropdownItemTriggerRightElement } from '@/components/ui/forms/dropdown/renderDropdownItemTriggerRightElement';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import type { AgentInputExtraActionChip, AgentInputExtraActionChipRenderContext } from '@/components/sessions/agentInput/agentInputContracts';

/**
 * The `selects` presentation's one trigger: a Session choice drawn as the bordered field select a
 * form's Machine and folder rows use, sized to its value and wrapping with its neighbours. It opens the
 * same picker the composer chip opens; only the trigger differs. Option fields, Connected Services,
 * MCP servers and approval profiles all draw this one, so the row reads as one set.
 */
export function SessionAuthoringFieldSelectTrigger(
  props: Readonly<{
    anchorRef: React.RefObject<React.ComponentRef<typeof View> | null>;
    /** The field's name, for the accessible name ("Permissions: Default"); never drawn. */
    title: string;
    label: string;
    leading?: React.ReactNode;
    open: boolean;
    disabled?: boolean;
    accessibilityHint?: string;
    /** `column`: beside a row label, the width its row gives fields (a Workspace row); default sized to its value. */
    span?: 'content' | 'column';
    onPress: () => void;
    testID: string;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  return (
    <View
      ref={props.anchorRef}
      collapsable={false}
      style={props.span === 'column' ? { alignSelf: 'stretch' } : { alignSelf: 'flex-start', maxWidth: '100%' }}
    >
      <HappierPressable
        testID={props.testID}
        accessibilityRole="button"
        accessibilityLabel={`${props.title}: ${props.label}`}
        {...(props.accessibilityHint === undefined
          ? {}
          : { accessibilityHint: props.accessibilityHint })}
        disabled={props.disabled === true}
        expanded={props.open}
        hasPopup="menu"
        onPress={props.onPress}
        // The field box inside draws the ring.
        style={HAPPIER_FOCUS_RING_DELEGATED_STYLE}
      >
        {(state) =>
          renderDropdownItemTriggerRightElement({
            leading: props.leading,
            detail: props.label,
            open: props.open,
            detailColor: theme.colors.text.primary,
            chevronColor: theme.colors.text.secondary,
            // Beside its label the field takes the row's field width; elsewhere it is sized to its value.
            fieldSpan: props.span === 'column' ? 'row' : 'content',
            field: resolveFieldBoxColors(
              theme,
              state.focused ? 'focused' : 'idle',
            ),
          })
        }
      </HappierPressable>
    </View>
  );
}

/**
 * A composer chip descriptor (Connected Services, MCP servers) in either trigger: its own chip, or the
 * field select drawn from the same descriptor's name, value and mark. The popover stays the host's.
 */
export function SessionAuthoringChipDescriptorTrigger(props: Readonly<{
    chip: AgentInputExtraActionChip;
    renderContext: AgentInputExtraActionChipRenderContext;
    trigger: 'chip' | 'select' | undefined;
    anchorRef: React.RefObject<React.ComponentRef<typeof View> | null>;
    open: boolean;
    onToggle: () => void;
    testID: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    if (props.trigger !== 'select') return <>{props.chip.render(props.renderContext)}</>;
    const popover = props.chip.collapsedContentPopover;
    const title = popover?.title ?? '';
    return (
        <SessionAuthoringFieldSelectTrigger
            anchorRef={props.anchorRef}
            title={title}
            label={popover?.label ?? title}
            leading={popover?.icon?.(theme.colors.text.secondary)}
            open={props.open}
            onPress={props.onToggle}
            testID={`${props.testID}-select`}
        />
    );
}
