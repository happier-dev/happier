import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';

import { EmbeddedTerminalPane } from '@/components/terminal/embedded/EmbeddedTerminalPane.native';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';

import {
    closeEmbeddedTerminalOutsideDockLocation,
    openEmbeddedTerminalInDockLocation,
    SESSION_PRIMARY_TERMINAL_INSTANCE_ID,
    type EmbeddedTerminalDockLocation,
} from './embeddedTerminalDocking';
import type { EmbeddedTerminalRendererHandle } from '@/components/terminal/embedded/embeddedTerminalRendererHandle';
import { useSessionEmbeddedTerminalPty } from './useSessionEmbeddedTerminalPty';

import type { SessionEmbeddedTerminalPaneProps } from './SessionEmbeddedTerminalPane.web';

export const SessionEmbeddedTerminalPane = React.memo(function SessionEmbeddedTerminalPaneNative(props: SessionEmbeddedTerminalPaneProps) {
    const { theme } = useUnistyles();
    const pane = useAppPaneScope(props.scopeId);
    const deviceType = useDeviceType();
    const showDockMenu = deviceType !== 'phone';
    const showQuickKeys = deviceType === 'phone';

    const [dockMenuOpen, setDockMenuOpen] = React.useState(false);
    const [, setDockLocationSetting] = useLocalSettingMutable('embeddedTerminalDockLocation');

    const testIdPrefix = props.testIdPrefix === undefined ? 'session-embedded-terminal' : props.testIdPrefix;
    const testId = React.useCallback(
        (suffix: string) => (testIdPrefix ? `${testIdPrefix}-${suffix}` : undefined),
        [testIdPrefix],
    );

    const terminalRendererRef = React.useRef<EmbeddedTerminalRendererHandle | null>(null);
    const resolvedTerminalInstanceId = props.currentDockLocation === 'details'
        ? (props.terminalInstanceId ?? SESSION_PRIMARY_TERMINAL_INSTANCE_ID)
        : props.terminalInstanceId;
    const terminalKey = React.useMemo(
        () => resolvedTerminalInstanceId
            ? `session:${props.sessionId}:terminal:${resolvedTerminalInstanceId}`
            : `session:${props.sessionId}:terminal`,
        [props.sessionId, resolvedTerminalInstanceId],
    );

    const controller = useSessionEmbeddedTerminalPty({
        sessionId: props.sessionId,
        terminalKey,
        terminalRef: terminalRendererRef,
    });

    const dockItems = React.useMemo(
        () => [
            {
                id: 'sidebar',
                title: t('terminalEmbedded.location.sidebar'),
                icon: <Ionicons name="albums-outline" size={18} color={theme.colors.text.secondary} />,
            },
            {
                id: 'details',
                title: t('terminalEmbedded.location.details'),
                icon: <Ionicons name="information-circle-outline" size={18} color={theme.colors.text.secondary} />,
            },
            {
                id: 'bottom',
                title: t('terminalEmbedded.location.bottom'),
                icon: <Ionicons name="reorder-four-outline" size={18} color={theme.colors.text.secondary} />,
            },
        ],
        [theme.colors.text.secondary],
    );

    const onSelectDock = React.useCallback(
        (id: string) => {
            const next = id as EmbeddedTerminalDockLocation;
            setDockMenuOpen(false);
            if (next === props.currentDockLocation) return;
            setDockLocationSetting(next);
            closeEmbeddedTerminalOutsideDockLocation({ pane, dockLocation: next });
            openEmbeddedTerminalInDockLocation({ pane, dockLocation: next });
        },
        [pane, props.currentDockLocation, setDockLocationSetting],
    );

    const toolbarActionsStart = React.useMemo(() => {
        if (!showDockMenu && !props.onOpenNewTerminalTab) {
            return null;
        }

        return (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                {props.onOpenNewTerminalTab ? (
                    <IconButton
                        testID={testId('new-tab')}
                        iconName="add-outline"
                        accessibilityLabel={t('terminalEmbedded.openNewTabA11y')}
                        tooltip={t('terminalEmbedded.openNewTabA11y')}
                        variant="plain"
                        size={28}
                        iconSize={18}
                        onPress={props.onOpenNewTerminalTab}
                    />
                ) : null}
                {showDockMenu ? (
                    <DropdownMenu
                        open={dockMenuOpen}
                        onOpenChange={setDockMenuOpen}
                        variant="selectable"
                        search={false}
                        selectedId={props.currentDockLocation}
                        showCategoryTitles={false}
                        matchTriggerWidth={false}
                        connectToTrigger={false}
                        rowKind="selectableRow"
                        trigger={({ toggle }) => (
                            <Pressable
                                testID={testId('dock')}
                                accessibilityRole="button"
                                accessibilityLabel={t('terminalEmbedded.dockMenuA11y')}
                                onPress={toggle}
                            >
                                <Ionicons name="move-outline" size={18} color={theme.colors.text.secondary} />
                            </Pressable>
                        )}
                        items={dockItems}
                        onSelect={onSelectDock}
                    />
                ) : null}
            </View>
        );
    }, [
        dockItems,
        dockMenuOpen,
        onSelectDock,
        props.currentDockLocation,
        props.onOpenNewTerminalTab,
        testId,
        theme.colors.text.secondary,
        showDockMenu,
    ]);

    return (
        <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
            <EmbeddedTerminalPane
                title={t('settings.terminal')}
                controller={controller}
                terminalRef={terminalRendererRef}
                onRequestClose={props.onRequestClose}
                testIdPrefix={testIdPrefix}
                nativeSurfaceKey={terminalKey}
                showQuickKeys={showQuickKeys}
                toolbarActionsStart={toolbarActionsStart}
            />
        </View>
    );
});

export default SessionEmbeddedTerminalPane;
