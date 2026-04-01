import * as React from 'react';

import {
    SshCredentialsFields,
    type SshAuthMode,
    type SshCredentialsDraft,
} from '@/components/settings/machines/shared/SshCredentialsFields';

export type WizardSshCredentialsFieldsProps = Readonly<{
    testIDPrefix: string;
    value: SshCredentialsDraft;
    onChange: (next: SshCredentialsDraft) => void;
    supportedAuthModes?: ReadonlyArray<SshAuthMode>;
    disabled?: boolean;
    testIdStyle?: 'wizard' | 'settings';
}>;

export const WizardSshCredentialsFields = React.memo(function WizardSshCredentialsFields(props: WizardSshCredentialsFieldsProps) {
    const style = props.testIdStyle ?? 'wizard';
    const rootTestIDPrefix = React.useMemo(() => {
        if (style !== 'wizard') return null;
        const suffix = '-remote-ssh';
        if (!props.testIDPrefix.endsWith(suffix)) return null;
        return props.testIDPrefix.slice(0, -suffix.length);
    }, [props.testIDPrefix, style]);
    const testIDs = style === 'wizard'
        ? {
            sshUsername: `${props.testIDPrefix}-sshUsernameInput`,
            sshHost: `${props.testIDPrefix}-sshHostInput`,
            sshPort: `${props.testIDPrefix}-sshPortInput`,
            sshAuthAgent: `${props.testIDPrefix}-sshAuthAgent`,
            sshAuthKeyfile: `${props.testIDPrefix}-sshAuthKeyfile`,
            sshAuthPassword: `${props.testIDPrefix}-sshAuthPassword`,
            sshIdentityFile: rootTestIDPrefix ? `${rootTestIDPrefix}-remote-identity-file` : `${props.testIDPrefix}-sshIdentityFile`,
            sshPassword: `${props.testIDPrefix}-sshPasswordInput`,
        }
        : undefined;

    return (
        <SshCredentialsFields
            testIDPrefix={props.testIDPrefix}
            testIDs={testIDs}
            supportedAuthModes={props.supportedAuthModes}
            disabled={props.disabled}
            layoutVariant={style}
            value={props.value}
            onChange={props.onChange}
        />
    );
});
