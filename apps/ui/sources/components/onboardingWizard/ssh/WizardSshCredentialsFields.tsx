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
            sshUsername: `${props.testIDPrefix}-username`,
            sshHost: `${props.testIDPrefix}-host`,
            sshPort: `${props.testIDPrefix}-port`,
            sshAuthAgent: `${props.testIDPrefix}-auth:agent`,
            sshAuthKeyfile: `${props.testIDPrefix}-auth:keyfile`,
            sshAuthPassword: `${props.testIDPrefix}-auth:password`,
            sshIdentityFile: rootTestIDPrefix ? `${rootTestIDPrefix}-remote-identity-file` : `${props.testIDPrefix}-identity-file`,
            sshPassword: `${props.testIDPrefix}-password`,
        }
        : undefined;

    return (
        <SshCredentialsFields
            testIDPrefix={props.testIDPrefix}
            testIDs={testIDs}
            supportedAuthModes={props.supportedAuthModes}
            disabled={props.disabled}
            value={props.value}
            onChange={props.onChange}
        />
    );
});
