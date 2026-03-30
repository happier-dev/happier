import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';

import { EmbeddedTerminalPane } from '@/components/terminal/embedded/EmbeddedTerminalPane.native';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';

import {
    closeEmbeddedTerminalOutsideDockLocation,
    openEmbeddedTerminalInDockLocation,
    type EmbeddedTerminalDockLocation,
} from './embeddedTerminalDocking';
import type { EmbeddedTerminalRendererHandle } from './embeddedTerminalRendererHandle';
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
    const terminalKey = React.useMemo(() => `session:${props.sessionId}:terminal`, [props.sessionId]);

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
                icon: <Ionicons name="albums-outline" size={18} color={theme.colors.textSecondary} />,
            },
            {
                id: 'details',
                title: t('terminalEmbedded.location.details'),
                icon: <Ionicons name="information-circle-outline" size={18} color={theme.colors.textSecondary} />,
            },
            {
                id: 'bottom',
                title: t('terminalEmbedded.location.bottom'),
                icon: <Ionicons name="reorder-four-outline" size={18} color={theme.colors.textSecondary} />,
            },
        ],
        [theme.colors.textSecondary],
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

    return (
        <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
            <EmbeddedTerminalPane
                title={t('settings.terminal')}
                controller={controller}
                terminalRef={terminalRendererRef}
                onRequestClose={props.onRequestClose}
                testIdPrefix={testIdPrefix}
                showQuickKeys={showQuickKeys}
                toolbarActionsStart={showDockMenu ? (
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
                                <Ionicons name="move-outline" size={18} color={theme.colors.textSecondary} />
                            </Pressable>
                        )}
                        items={dockItems}
                        onSelect={onSelectDock}
                    />
                ) : null}
            />
        </View>
    );
});

export default SessionEmbeddedTerminalPane;
