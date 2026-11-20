import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';

import { SegmentedTabBar, type SegmentedTab } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { CopyIconButton } from '@/components/ui/copy/CopyIconButton';

import { CodeBlockView } from './CodeBlockView';

export type CommandOs = 'macos' | 'linux' | 'windows';

export const COMMAND_OS_ORDER: readonly CommandOs[] = ['macos', 'linux', 'windows'];

/**
 * One terminal command shown per operating system: macOS · Linux · Windows as a segmented control in
 * the code block's header, the command for the chosen one, and Copy. The one owner of "pick your OS,
 * copy the command" (Add a machine, agent setup, first-run onboarding). Controlled through `os` /
 * `onOsChange` when the choice is kept elsewhere (a flow that survives the block unmounting);
 * otherwise it starts on `detectedOs`, else macOS. `detectedLabel` marks the tab this device runs.
 */
export const OsCommandBlock = React.memo(function OsCommandBlock(props: Readonly<{
    testID: string;
    commands: Readonly<Record<CommandOs, string | null>>;
    unavailableContent?: React.ReactNode;
    os?: CommandOs;
    onOsChange?: (os: CommandOs) => void;
    detectedOs?: CommandOs | null;
    detectedLabel?: string;
    /**
     * `line`: a signed-out step's one command (lab direction A "Create it on the machine itself"): the OS choice centred
     * above one single-line row with its prompt, the command truncating at its end, and Copy. macOS and Linux share a
     * segment when their command is the same. `block` (default): the wrapped code block with the choice in its header.
     */
    presentation?: 'block' | 'line';
}>) {
    const styles = stylesheet;
    const [ownOs, setOwnOs] = React.useState<CommandOs>(props.detectedOs ?? 'macos');
    const os = props.os ?? ownOs;
    const { onOsChange } = props;
    const selectOs = React.useCallback((next: CommandOs) => {
        setOwnOs(next);
        onOsChange?.(next);
    }, [onOsChange]);
    const tabs = React.useMemo((): ReadonlyArray<SegmentedTab<CommandOs>> => [
        { id: 'macos', label: t('setupOnboarding.handoffPlatformMacosLabel') },
        { id: 'linux', label: t('setupOnboarding.handoffPlatformLinuxLabel') },
        { id: 'windows', label: t('setupOnboarding.handoffPlatformWindowsLabel') },
    ], []);
    const detected = props.detectedOs && props.detectedLabel && props.detectedOs === os ? props.detectedLabel : null;
    const unixShared = props.commands.macos !== null && props.commands.macos === props.commands.linux;
    const lineTabs = React.useMemo((): ReadonlyArray<SegmentedTab<CommandOs>> => (unixShared ? [
        { id: 'macos', label: t('setupOnboarding.handoffPlatformMacosLinuxLabel') },
        { id: 'windows', label: t('setupOnboarding.handoffPlatformWindowsLabel') },
    ] : tabs), [tabs, unixShared]);

    if (props.presentation === 'line') {
        const lineOs = unixShared && os === 'linux' ? 'macos' : os;
        const lineCommand = props.commands[lineOs];
        return (
            <View testID={props.testID} style={styles.lineRoot}>
                <SegmentedTabBar
                    tabs={lineTabs}
                    activeTabId={lineOs}
                    onSelectTab={selectOs}
                    testIDPrefix={`${props.testID}.os`}
                    segmentSizing="content"
                    role="radiogroup"
                />
                {lineCommand === null ? (props.unavailableContent ?? <Text>{t('common.unavailable')}</Text>) : (
                    // The command line is an Element: glass where it stands on an atmosphere (the welcome planet), its
                    // solid paint elsewhere; its Copy takes that material's inner fill.
                    <GlassSurface surfaceGroup="card" nested finishRole={null} style={styles.lineRow}>
                        <Text style={styles.linePrompt} accessibilityElementsHidden importantForAccessibility="no">
                            {lineOs === 'windows' ? '>' : '$'}
                        </Text>
                        <Text testID={`${props.testID}.code`} style={styles.lineCode} numberOfLines={1} ellipsizeMode="tail" selectable>
                            {lineCommand}
                        </Text>
                        <CopyIconButton testID={`${props.testID}.copy`} text={lineCommand} />
                    </GlassSurface>
                )}
            </View>
        );
    }

    const header = (
        <View style={styles.header}>
            <SegmentedTabBar
                tabs={tabs}
                activeTabId={os}
                onSelectTab={selectOs}
                testIDPrefix={`${props.testID}.os`}
                compact
                segmentSizing="content"
                role="radiogroup"
            />
            {detected ? <Text style={styles.detected}>{detected}</Text> : null}
        </View>
    );
    const command = props.commands[os];
    return (
        <View testID={props.testID}>
            {command === null ? <>{header}{props.unavailableContent ?? <Text>{t('common.unavailable')}</Text>}</> : <CodeBlockView
                code={command}
                language={os === 'windows' ? 'powershell' : 'bash'}
                showHeaderRow
                headerLeft={header}
                // The one command must be fully readable: it wraps, never scrolls out of sight.
                wrap
                showCopyButton
                scrollTestID={`${props.testID}.code`}
            />}
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        flexShrink: 1,
    },
    lineRoot: {
        width: '100%',
        alignItems: 'center',
        gap: theme.space.s16,
    },
    lineRow: {
        width: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s10,
        minHeight: 48,
        paddingLeft: theme.space.s16,
        paddingRight: theme.space.s8,
        borderRadius: theme.borderRadius.lg,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    linePrompt: {
        ...Typography.variant('label'),
        ...Typography.mono(),
        color: theme.colors.text.tertiary,
    },
    lineCode: {
        ...Typography.variant('label'),
        ...Typography.mono(),
        flex: 1,
        minWidth: 0,
        color: theme.colors.text.primary,
    },
    detected: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.tertiary,
    },
}));
