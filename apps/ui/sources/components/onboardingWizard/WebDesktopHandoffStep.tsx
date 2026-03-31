import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

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

    return (
        <View testID={props.testID} style={styles.root}>
            <WebDesktopDownloadCta testIDPrefix={props.testID} />
            <WizardTerminalHandoff
                testID={`${props.testID}-terminal`}
                steps={buildWebDesktopRelayHostHandoffSteps({
                    cliInstallCommand,
                    includeDaemonInstall: true,
                })}
            />
            <View testID={`${props.testID}-optional`} style={styles.downloadBlock}>
                <Text style={styles.downloadTitle}>{t('setupOnboarding.webDesktopOnlyOptionalNextTitle')}</Text>
                <Text style={styles.downloadSubtitle}>{t('setupOnboarding.webDesktopOnlyOptionalNextBody')}</Text>
            </View>
        </View>
    );
}
