import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { StepOrDivider } from '@/components/onboarding/unauthShell/StepFormParts';
import { OsCommandBlock } from '@/components/ui/code/blocks/OsCommandBlock';
import { t } from '@/text';

import { buildCliInstallAndRunCommandForCurrentApp, buildCliInstallAndRunPowershellCommandForCurrentApp } from '../../commands/wizardCliCommands';
import { WebDesktopDownloadCta } from './WebDesktopDownloadCta';

export type WebDesktopRelayHostHandoffContentProps = Readonly<{
    testID: string;
}>;

/**
 * Creating a Personal Home from a browser (lab direction A "Create it on the machine itself"): the one command for the
 * machine that will host it, as a single line with its OS choice and Copy, then the desktop app behind the centred "or".
 * The step's heading says the rest; no section heading or explainer of its own.
 */
export function WebDesktopRelayHostHandoffContent(props: WebDesktopRelayHostHandoffContentProps) {
    const unixCommand = React.useMemo(() => buildCliInstallAndRunCommandForCurrentApp({ action: 'home-create' }), []);
    const windowsCommand = React.useMemo(() => buildCliInstallAndRunPowershellCommandForCurrentApp({ action: 'home-create' }), []);
    const commands = React.useMemo(() => ({ macos: unixCommand, linux: unixCommand, windows: windowsCommand }), [unixCommand, windowsCommand]);

    return (
        <View testID={props.testID} style={styles.root}>
            <OsCommandBlock testID={`${props.testID}-terminal`} commands={commands} presentation="line" />
            <StepOrDivider label={t('common.or')} />
            <WebDesktopDownloadCta testIDPrefix={props.testID} />
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    root: {
        width: '100%',
        alignItems: 'center',
        gap: theme.space.s16,
    },
}));
