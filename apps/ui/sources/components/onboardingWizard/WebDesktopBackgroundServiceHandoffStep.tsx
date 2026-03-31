import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import type { WizardTerminalHandoffStep } from './WizardTerminalHandoff';
import { WizardTerminalHandoff } from './WizardTerminalHandoff';
import { buildCliInstallCommandForCurrentApp } from './wizardCliCommands';
import { WebDesktopDownloadCta } from './WebDesktopDownloadCta';

export type WebDesktopBackgroundServiceHandoffStepProps = Readonly<{
    testID: string;
    relayUrl: string;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        width: '100%',
        gap: 18,
        alignItems: 'center',
    },
    noteBlock: {
        width: '100%',
        gap: 10,
        alignItems: 'center',
    },
    noteTitle: {
        textAlign: 'center',
        color: theme.colors.text,
        fontSize: 16,
        lineHeight: 22,
    },
    noteSubtitle: {
        textAlign: 'center',
        color: theme.colors.textSecondary,
        fontSize: 13,
        lineHeight: 18,
    },
}));

function buildDaemonHandoffSteps(input: Readonly<{ cliInstallCommand: string; relayUrl: string }>): readonly WizardTerminalHandoffStep[] {
    const relayArg = JSON.stringify(input.relayUrl);
    return [
        {
            title: t('setupOnboarding.webDesktopOnlyCliTitle'),
            subtitle: t('setupOnboarding.webDesktopOnlyCliSubtitle'),
            code: input.cliInstallCommand,
            scrollTestIDSuffix: 'cli-install',
        },
        {
            title: t('setupOnboarding.customRelayUrlLabel'),
            subtitle: t('setupOnboarding.relayCustomUrlSubtitle'),
            code: `happier relay set ${relayArg}`,
            scrollTestIDSuffix: 'relay-set',
        },
        {
            title: t('sessionGettingStarted.steps.daemonInstall.title'),
            subtitle: t('sessionGettingStarted.steps.daemonInstall.description'),
            code: 'happier daemon install',
            scrollTestIDSuffix: 'daemon-install',
        },
        {
            title: t('sessionGettingStarted.steps.daemonStart.title'),
            subtitle: t('sessionGettingStarted.steps.daemonStart.description'),
            code: 'happier daemon start',
            scrollTestIDSuffix: 'daemon-start',
        },
    ];
}

export function WebDesktopBackgroundServiceHandoffStep(props: WebDesktopBackgroundServiceHandoffStepProps) {
    useUnistyles();
    const styles = stylesheet;
    const cliInstallCommand = React.useMemo(() => buildCliInstallCommandForCurrentApp(), []);

    return (
        <View testID={props.testID} style={styles.root}>
            <WizardTerminalHandoff
                testID={`${props.testID}-terminal`}
                steps={buildDaemonHandoffSteps({
                    cliInstallCommand,
                    relayUrl: props.relayUrl,
                })}
            />

            <WebDesktopDownloadCta testIDPrefix={props.testID} />

            <View testID={`${props.testID}-optional`} style={styles.noteBlock}>
                <Text style={styles.noteTitle}>{t('setupOnboarding.webDesktopOnlyOptionalNextTitle')}</Text>
                <Text style={styles.noteSubtitle}>{t('setupOnboarding.webDesktopOnlyOptionalNextBody')}</Text>
            </View>
        </View>
    );
}
