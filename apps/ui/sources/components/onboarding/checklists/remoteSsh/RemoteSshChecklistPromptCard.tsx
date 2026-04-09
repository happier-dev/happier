import * as React from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { MachineSetupTextField } from '@/components/ui/forms/MachineSetupTextField';
import type { RemoteSshBootstrapPrompt } from '@/components/systemTasks/remoteSshBootstrap/useRemoteSshBootstrapTask';
import { buildBackgroundServiceReplacementPromptBody } from '@/components/systemTasks/prompts/backgroundServiceReplacementPromptPresentation';

import { remoteSshChecklistStyles } from './styles';

export type RemoteSshChecklistPromptCardProps = Readonly<{
    testID: string;
    prompt: RemoteSshBootstrapPrompt;
    password: string;
    isStarting: boolean;
    onChangePassword: (nextPassword: string) => void;
}>;

export const RemoteSshChecklistPromptCard = React.memo(function RemoteSshChecklistPromptCard(
    props: RemoteSshChecklistPromptCardProps,
) {
    const styles = remoteSshChecklistStyles;

    if (props.prompt.kind === 'ssh.password') {
        return (
            <View style={styles.promptCard}>
                <Text style={styles.promptTitle}>{props.prompt.message}</Text>
                {props.prompt.target ? <Text style={styles.promptBody}>{props.prompt.target}</Text> : null}
                <MachineSetupTextField
                    testID={props.testID}
                    label={t('settings.machineSetupRemoteSshPasswordLabel')}
                    value={props.password}
                    editable={!props.isStarting}
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    onChangeText={props.onChangePassword}
                />
            </View>
        );
    }

    return (
        <View style={styles.promptCard}>
            <Text style={styles.promptTitle}>{props.prompt.message}</Text>
            <Text style={styles.promptBody}>
                {props.prompt.kind === 'auth.approveRemoteProvisioning'
                    ? props.prompt.publicKey ?? ''
                    : props.prompt.kind === 'daemon.replaceRemoteBackgroundServices'
                        ? buildBackgroundServiceReplacementPromptBody({
                            targetServerUrl: props.prompt.targetServerUrl,
                            targetReleaseChannel: props.prompt.targetReleaseChannel,
                            services: props.prompt.services,
                            format: 'detailed',
                        }) ?? ''
                    : [
                        props.prompt.host,
                        props.prompt.keyType,
                        props.prompt.fingerprint,
                        props.prompt.kind === 'ssh.replaceHostKey' ? props.prompt.existingFingerprint : null,
                    ].filter(Boolean).join('\n')}
            </Text>
        </View>
    );
});
