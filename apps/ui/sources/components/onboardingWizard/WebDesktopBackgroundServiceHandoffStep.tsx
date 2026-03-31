import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { WizardChoiceRow } from './WizardChoiceRow';
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
    modePicker: {
        width: '100%',
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
    const [handoffMode, setHandoffMode] = React.useState<'desktopApp' | 'cli'>('desktopApp');

    return (
        <View testID={props.testID} style={styles.root}>
            <View testID={`${props.testID}-mode`} style={styles.modePicker}>
                <WizardChoiceRow
                    testID={`${props.testID}-mode-desktop`}
                    selected={handoffMode === 'desktopApp'}
                    icon="desktop-outline"
                    title={t('setupOnboarding.webDesktopHandoffDesktopAppOption')}
                    subtitle={t('setupOnboarding.webDesktopHandoffDesktopAppSubtitle')}
                    onPress={() => setHandoffMode('desktopApp')}
                />
                <WizardChoiceRow
                    testID={`${props.testID}-mode-cli`}
                    selected={handoffMode === 'cli'}
                    icon="terminal-outline"
                    title={t('setupOnboarding.webDesktopHandoffCliOption')}
                    subtitle={t('setupOnboarding.webDesktopHandoffCliSubtitle')}
                    onPress={() => setHandoffMode('cli')}
                />
            </View>

            {handoffMode === 'desktopApp' ? (
                <WebDesktopDownloadCta testIDPrefix={props.testID} />
            ) : (
                <WizardTerminalHandoff
                    testID={`${props.testID}-terminal`}
                    steps={buildDaemonHandoffSteps({
                        cliInstallCommand,
                        relayUrl: props.relayUrl,
                    })}
                />
            )}

            <View testID={`${props.testID}-optional`} style={styles.noteBlock}>
                <Text style={styles.noteTitle}>{t('setupOnboarding.webDesktopOnlyOptionalNextTitle')}</Text>
                <Text style={styles.noteSubtitle}>{t('setupOnboarding.webDesktopOnlyOptionalNextBody')}</Text>
            </View>
        </View>
    );
}
