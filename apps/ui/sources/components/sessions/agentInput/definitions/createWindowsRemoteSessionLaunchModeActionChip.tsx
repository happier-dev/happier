import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { WindowsRemoteSessionLaunchMode } from '@happier-dev/protocol';

import type {
    AgentInputExtraActionChip,
    AgentInputExtraActionChipRenderContext,
} from '@/components/sessions/agentInput/agentInputContracts';
import { AgentInputSimpleOptionsPopover } from '@/components/sessions/agentInput/components/AgentInputSimpleOptionsPopover';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import {
    listAvailableWindowsRemoteSessionLaunchModes,
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
    const availableModes = listAvailableWindowsRemoteSessionLaunchModes({
        windowsTerminalAvailable: params.windowsTerminalAvailable,
    });

    return WINDOWS_REMOTE_SESSION_LAUNCH_MODE_OPTIONS
        .filter((option) => availableModes.includes(option.value))
        .map((option) => ({
            id: option.value,
            label: t(option.labelKey),
            subtitle: t(option.subtitleKey),
        }));
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
    const options = React.useMemo(
        () => buildWindowsRemoteSessionLaunchModeOptions({
            windowsTerminalAvailable: props.windowsTerminalAvailable,
        }),
        [props.windowsTerminalAvailable],
    );

    return (
        <>
            <View ref={anchorRef} collapsable={false} style={{ alignSelf: 'flex-start' }}>
                <Pressable
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

            <AgentInputSimpleOptionsPopover
                open={open}
                anchorRef={anchorRef}
                title={t('machine.windows.remoteSessionModeTitle')}
                options={options}
                selectedOptionId={props.mode}
                onSelect={(nextId) => {
                    if (nextId === 'hidden' || nextId === 'windows_terminal' || nextId === 'console') {
                        props.onModeChange(nextId);
                    }
                    setOpen(false);
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
            title: t('machine.windows.remoteSessionModeTitle'),
            label: t(selectedOption?.shortLabelKey ?? 'windowsRemoteSessionLaunchMode.shortHidden'),
            icon: (tint) => normalizeNodeForView(<Ionicons name="logo-windows" size={16} color={tint} />),
            options: buildWindowsRemoteSessionLaunchModeOptions({
                windowsTerminalAvailable: params.windowsTerminalAvailable,
            }),
            selectedOptionId: params.mode,
            onSelect: (selectedId) => {
                if (selectedId === 'hidden' || selectedId === 'windows_terminal' || selectedId === 'console') {
                    params.onModeChange(selectedId);
                }
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
