import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { WizardChoiceRow } from './WizardChoiceRow';
import { WizardTerminalHandoff } from './WizardTerminalHandoff';
import { buildCliInstallCommandForCurrentApp } from './wizardCliCommands';
import { buildWebDesktopRelayHostHandoffSteps } from './webDesktopHandoffSteps';
import { WebDesktopDownloadCta } from './WebDesktopDownloadCta';

export type WebDesktopHandoffStepProps = Readonly<{
    testID: string;
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
    downloadBlock: {
        width: '100%',
        gap: 10,
        alignItems: 'center',
    },
    downloadTitle: {
        textAlign: 'center',
        color: theme.colors.text,
        fontSize: 16,
        lineHeight: 22,
    },
    downloadSubtitle: {
        textAlign: 'center',
        color: theme.colors.textSecondary,
        fontSize: 13,
        lineHeight: 18,
    },
}));

export function WebDesktopHandoffStep(props: WebDesktopHandoffStepProps) {
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
                    steps={buildWebDesktopRelayHostHandoffSteps({
                        cliInstallCommand,
                        includeDaemonInstall: false,
                    })}
                />
            )}
            <View testID={`${props.testID}-optional`} style={styles.downloadBlock}>
                <Text style={styles.downloadTitle}>{t('setupOnboarding.webDesktopOnlyOptionalNextTitle')}</Text>
                <Text style={styles.downloadSubtitle}>{t('setupOnboarding.webDesktopOnlyOptionalNextBody')}</Text>
            </View>
        </View>
    );
}
