import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SegmentedTabBar, type SegmentedTab } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

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
    os?: CommandOs;
    onOsChange?: (os: CommandOs) => void;
    detectedOs?: CommandOs | null;
    detectedLabel?: string;
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
            {command === null ? <>{header}<Text>{t('common.unavailable')}</Text></> : <CodeBlockView
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
    detected: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.tertiary,
    },
}));
