import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { StepFieldHelp, StepOrDivider } from '@/components/onboarding/unauthShell/StepFormParts';
import { OsCommandBlock, type CommandOs } from '@/components/ui/code/blocks/OsCommandBlock';
import { t } from '@/text';

import { buildCliInstallAndRunCommandForCurrentApp, buildCliInstallAndRunPowershellCommandForCurrentApp } from '../../commands/wizardCliCommands';
import { WebDesktopDownloadCta } from './WebDesktopDownloadCta';

export type WebDesktopRelayHostHandoffContentProps = Readonly<{
    testID: string;
}>;

/**
 * Creating a Personal Home from a browser (lab direction A "Create it on the machine itself"): the one command for the
 * machine that will host it, then the desktop app behind the centred "or".
 */
export function WebDesktopRelayHostHandoffContent(props: WebDesktopRelayHostHandoffContentProps) {
    const unixCommand = React.useMemo(() => buildCliInstallAndRunCommandForCurrentApp({ action: 'home-create' }), []);
    const windowsCommand = React.useMemo(() => buildCliInstallAndRunPowershellCommandForCurrentApp({ action: 'home-create' }), []);
    const commands = React.useMemo(() => ({ macos: unixCommand, linux: unixCommand, windows: windowsCommand }), [unixCommand, windowsCommand]);
    return <WebDesktopCommandHandoff testID={props.testID} commandTestID={`${props.testID}-terminal`} commands={commands} />;
}

/**
 * A step a browser cannot do itself (lab direction A): the one command to run on the machine, as a single line with
 * its OS choice and Copy, a line under it when the step needs to say what happens next, then the desktop app behind
 * the centred "or". The step's heading says the rest; no section heading or explainer of its own.
 */
export function WebDesktopCommandHandoff(props: Readonly<{
    testID: string;
    commandTestID: string;
    commands: Readonly<Record<CommandOs, string | null>> | null;
    help?: string;
}>) {
    return (
        <View testID={props.testID} style={styles.root}>
            <View style={styles.command}>
                {props.commands
                    ? <OsCommandBlock testID={props.commandTestID} commands={props.commands} presentation="line" />
                    : <StepFieldHelp testID={props.commandTestID}>{t('common.unavailable')}</StepFieldHelp>}
                {props.help ? <StepFieldHelp>{props.help}</StepFieldHelp> : null}
            </View>
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
    command: {
        width: '100%',
        gap: theme.space.s8,
    },
}));
