import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { WindowsRemoteSessionLaunchMode } from '@happier-dev/protocol';

import type {
    AgentInputExtraActionChip,
    AgentInputExtraActionChipRenderContext,
} from '@/components/sessions/agentInput/agentInputContracts';
import { AgentInputSelectionListPopover } from '@/components/sessions/agentInput/components/AgentInputSelectionListPopover';
import type { SelectionListStep } from '@/components/ui/selectionList';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import {
    WINDOWS_REMOTE_SESSION_LAUNCH_MODE_OPTIONS,
} from '@/sync/domains/session/spawn/windowsRemoteSessionLaunchModeOptions';

type WindowsRemoteSessionLaunchModeChipProps = Readonly<{
    mode: WindowsRemoteSessionLaunchMode;
    windowsTerminalAvailable: boolean;
    onModeChange: (next: WindowsRemoteSessionLaunchMode) => void;
    ctx: AgentInputExtraActionChipRenderContext;
}>;

function buildWindowsRemoteSessionLaunchModeOptions(params: Readonly<{
    windowsTerminalAvailable: boolean;
}>) {
    return WINDOWS_REMOTE_SESSION_LAUNCH_MODE_OPTIONS
        .map((option) => ({
            id: option.value,
            label: t(option.labelKey),
            subtitle: option.value === 'windows_terminal' && !params.windowsTerminalAvailable
                ? `${t(option.subtitleKey)} ${t('machine.windows.windowsTerminalUnavailableSuffix')}`
                : t(option.subtitleKey),
            disabled: option.value === 'windows_terminal' && !params.windowsTerminalAvailable,
        }));
}

/**
 * Shared root-step builder used by BOTH the chip-definition factory (action-menu
 * route) and the inline `WindowsRemoteSessionLaunchModeChip` (direct chip
 * route). Per-option `onSelect` callbacks are the canonical action source for
 * `presentation: 'list'` descriptors.
 */
export function buildWindowsRemoteSessionLaunchModeRootStep(params: Readonly<{
    windowsTerminalAvailable: boolean;
    onSelect?: (selectedId: WindowsRemoteSessionLaunchMode) => void;
}>): SelectionListStep {
    const options = buildWindowsRemoteSessionLaunchModeOptions(params);
    return {
        id: 'windows-remote-session-launch-mode-root',
        title: t('machine.windows.remoteSessionModeTitle'),
        sections: [
            {
                kind: 'static',
                id: 'windows-remote-session-launch-mode',
                options: options.map((option) => ({
                    id: option.id,
                    label: option.label,
                    subtitle: option.subtitle,
                    disabled: option.disabled,
                    onSelect: params.onSelect && !option.disabled
                        ? () => params.onSelect!(option.id as WindowsRemoteSessionLaunchMode)
                        : undefined,
                })),
            },
        ],
    };
}

const WindowsRemoteSessionLaunchModeChip = React.memo(function WindowsRemoteSessionLaunchModeChip(
    props: WindowsRemoteSessionLaunchModeChipProps,
) {
    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<React.ElementRef<typeof View> | null>(null);
    const selectedOption = React.useMemo(
        () => WINDOWS_REMOTE_SESSION_LAUNCH_MODE_OPTIONS.find((option) => option.value === props.mode) ?? WINDOWS_REMOTE_SESSION_LAUNCH_MODE_OPTIONS[0],
        [props.mode],
    );
    const rootStep = React.useMemo(
        () => buildWindowsRemoteSessionLaunchModeRootStep({
            windowsTerminalAvailable: props.windowsTerminalAvailable,
            onSelect: props.onModeChange,
        }),
        [props.windowsTerminalAvailable, props.onModeChange],
    );

    return (
        <>
            <View ref={anchorRef} collapsable={false} style={{ alignSelf: 'flex-start' }}>
                <Pressable
                    testID="agent-input-windows-launch-mode-chip"
                    onPress={() => setOpen((current) => !current)}
                    hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                    style={({ pressed }) => props.ctx.chipStyle(Boolean(pressed))}
                    accessibilityRole="button"
                    accessibilityLabel={t('machine.windows.remoteSessionModeTitle')}
                >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Ionicons name="logo-windows" size={16} color={props.ctx.iconColor} />
                        {props.ctx.showLabel ? (
                            <Text numberOfLines={1} style={props.ctx.textStyle}>
                                {t(selectedOption?.shortLabelKey ?? 'windowsRemoteSessionLaunchMode.shortHidden')}
                            </Text>
                        ) : null}
                    </View>
                </Pressable>
            </View>

            <AgentInputSelectionListPopover
                open={open}
                anchorRef={anchorRef}
                rootStep={rootStep}
                selectedOptionId={props.mode}
                onSelect={() => {
                    // FR4-W1-CHIP: documented no-op. Per-row
                    // `SelectionListOption.onSelect` inside `rootStep`
                    // dispatched the launch-mode mutation. The wrapper
                    // `AgentInputSelectionListPopover` owns the close path and
                    // defers `onRequestClose` on web internally — calling
                    // `setOpen(false)` here would close the popover
                    // synchronously and allow the click to fall through to
                    // the chip anchor (re-opening it).
                }}
                onRequestClose={() => setOpen(false)}
                maxHeightCap={320}
            />
        </>
    );
});

export function createWindowsRemoteSessionLaunchModeActionChip(params: Readonly<{
    mode: WindowsRemoteSessionLaunchMode;
    windowsTerminalAvailable: boolean;
    onModeChange: (next: WindowsRemoteSessionLaunchMode) => void;
}>): AgentInputExtraActionChip {
    const selectedOption = WINDOWS_REMOTE_SESSION_LAUNCH_MODE_OPTIONS.find((option) => option.value === params.mode) ?? WINDOWS_REMOTE_SESSION_LAUNCH_MODE_OPTIONS[0];

    return {
        key: 'new-session-windows-remote-session-launch-mode',
        controlId: 'windowsRemoteSessionMode',
        collapsedOptionsPopover: {
            presentation: 'list',
            title: t('machine.windows.remoteSessionModeTitle'),
            label: t(selectedOption?.shortLabelKey ?? 'windowsRemoteSessionLaunchMode.shortHidden'),
            icon: (tint) => normalizeNodeForView(<Ionicons name="logo-windows" size={16} color={tint} />),
            rootStep: buildWindowsRemoteSessionLaunchModeRootStep({
                windowsTerminalAvailable: params.windowsTerminalAvailable,
                onSelect: params.onModeChange,
            }),
            selectedOptionId: params.mode,
            onSelect: () => {
                // List-mode option mutations live on per-option SelectionListOption.onSelect
                // (set inside `buildWindowsRemoteSessionLaunchModeRootStep`). The overlay
                // route closes on selection but does NOT call this descriptor-level callback.
                // Documented no-op for parity with the chip-picker contract.
            },
            maxHeightCap: 320,
        },
        render: (ctx) => (
            <WindowsRemoteSessionLaunchModeChip
                mode={params.mode}
                windowsTerminalAvailable={params.windowsTerminalAvailable}
                onModeChange={params.onModeChange}
                ctx={ctx}
            />
        ),
    };
}
