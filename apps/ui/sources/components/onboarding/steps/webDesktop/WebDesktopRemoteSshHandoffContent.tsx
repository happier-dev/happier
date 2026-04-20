import * as React from 'react';

import type { SshCredentialsDraft } from '@/components/ssh/SshCredentialsFields';
import { SshCredentialsFields } from '@/components/ssh/SshCredentialsFields';

import {
    buildCliInstallAndRunCommandForCurrentApp,
    buildCliInstallAndRunPowershellCommandForCurrentApp,
    buildRemoteMachineSetupCommand,
} from '../../commands/wizardCliCommands';
import { WizardGuidedHandoff, WizardGuidedHandoffTerminal } from '../../ui/WizardGuidedHandoff';
import { t } from '@/text';

export type WebDesktopRemoteSshHandoffContentProps = Readonly<{
    testID: string;
    terminalTestID?: string;
    sshFieldTestIDPrefix?: string;
    draft: SshCredentialsDraft;
    onDraftChange: (next: SshCredentialsDraft) => void;
    relayUrl: string | null;
    installRelayRuntime: boolean;
}>;

export function WebDesktopRemoteSshHandoffContent(props: WebDesktopRemoteSshHandoffContentProps) {
    const setupArgs = React.useMemo(() => {
        const args: string[] = [];
        if (props.relayUrl) {
            args.push('--relay-url', props.relayUrl);
        }
        args.push('--skip-providers', '--yes');
        return args;
    }, [props.relayUrl]);
    const installAndSetupCommand = React.useMemo(() => buildCliInstallAndRunCommandForCurrentApp({
        action: 'setup',
        args: setupArgs,
    }), [setupArgs]);
    const installAndSetupWindowsCommand = React.useMemo(() => buildCliInstallAndRunPowershellCommandForCurrentApp({
        action: 'setup',
        args: setupArgs,
    }), [setupArgs]);
    const sshCommand = React.useMemo(() => buildRemoteMachineSetupCommand({
        draft: props.draft,
        installRelayRuntime: props.installRelayRuntime,
    }), [props.draft, props.installRelayRuntime]);

    return (
        <WizardGuidedHandoff testID={props.testID}>
            <SshCredentialsFields
                testIDPrefix={props.sshFieldTestIDPrefix ?? `${props.testID}-ssh`}
                layoutVariant="wizard"
                value={props.draft}
                onChange={props.onDraftChange}
            />
            <WizardGuidedHandoffTerminal
                testID={props.terminalTestID ?? `${props.testID}-terminal`}
                steps={[
                    {
                        title: t('setupOnboarding.webDesktopOnlySetupCommandTitle'),
                        subtitle: t('setupOnboarding.webDesktopOnlySetupRemotePrereqsSubtitle'),
                        code: installAndSetupCommand,
                        windowsCode: installAndSetupWindowsCommand,
                        windowsLanguage: 'powershell',
                        scrollTestIDSuffix: 'setup',
                    },
                    {
                        title: t('settings.machineSetupSshMachineTitle'),
                        subtitle: t('settings.machineSetupSshMachineSubtitle'),
                        code: sshCommand,
                        scrollTestIDSuffix: 'remote-ssh-setup',
                    },
                ]}
            />
        </WizardGuidedHandoff>
    );
}
