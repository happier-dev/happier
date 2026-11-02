import * as React from 'react';
import type { RelayAccessConfig, RelayAccessProviderDescriptor } from '@happier-dev/cli-common/relayAccess/catalog';

import { ConnectedAccountPurposeTargetChooser } from '@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser';
import { SERVERS_SETTINGS } from '@/components/settings/server/serverSettings';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { t } from '@/text';

type RelayAccessCredentialRef = RelayAccessConfig['credentialRefs'][number];

/**
 * The access provider's declared credential purposes, each chosen as one connected account. It emits
 * exact references and never reads or holds credential material.
 */
export function RelayAccessCredentialFields(props: Readonly<{
    descriptor: RelayAccessProviderDescriptor;
    value: readonly RelayAccessCredentialRef[];
    onChange: (value: RelayAccessCredentialRef[]) => void;
    disabled?: boolean;
    testIDPrefix: string;
    /**
     * The Account the access action runs as. Choices come from the active Account, so a choice is only
     * offered when that is the same Account.
     */
    accountScope: ServerAccountScope | null;
}>) {
    const activeAccountScope = useActiveServerAccountScope();
    const accountScopeIsActive = areServerAccountScopesEqual(activeAccountScope, props.accountScope);

    return (
        <>
            {props.descriptor.definition.credentialPurposes.map((requirement) => {
                const binding = props.descriptor.homeUi?.credentialBindings?.find((entry) => entry.purpose === requirement.purpose);
                if (!binding) return null;
                const selected = props.value.find((entry) => entry.purpose === requirement.purpose)?.credentialRef;
                const chooser = (
                    <ConnectedAccountPurposeTargetChooser
                        testID={`${props.testIDPrefix}:credential:${requirement.purpose}`}
                        localizedTextPluginId={binding.service.pluginId}
                        declaration={{ purpose: requirement.purpose, service: binding.service, required: requirement.required }}
                        value={selected?.kind === 'connectedAccount' ? { kind: 'account', account: selected.account } : null}
                        accountsOnly
                        disabled={props.disabled || !accountScopeIsActive}
                        disabledReason={accountScopeIsActive ? undefined : t('connectedServices.purposeTargets.signInToChoose')}
                        onChange={(target) => props.onChange([
                            ...props.value.filter((entry) => entry.purpose !== requirement.purpose),
                            ...(target?.kind === 'account'
                                ? [{ purpose: requirement.purpose, credentialRef: { kind: 'connectedAccount' as const, account: target.account } }]
                                : []),
                        ])}
                    />
                );
                // Settings search lands on the row through the binding's declared setting.
                return binding.settingKey
                    ? <SettingAnchor key={requirement.purpose} setting={SERVERS_SETTINGS.settings[binding.settingKey]}>{chooser}</SettingAnchor>
                    : <React.Fragment key={requirement.purpose}>{chooser}</React.Fragment>;
            })}
        </>
    );
}
