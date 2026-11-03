import * as React from 'react';
import { View } from 'react-native';

import { useRequestPersonalHomeBootstrap } from '@/components/personalHome/bootstrap/personalHomeBootstrapRequest';
import { OrganizationPolicyFieldNotice } from '@/components/organizationPolicy/OrganizationPolicyFieldNotice';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';


/** Local Home creation uses the complete Personal Home lifecycle, including identity and signup closure. */
export function RelayHostLocalChecklistStep(props: Readonly<{
    testID?: string;
    onWizardPrimaryChange?: (state: Readonly<{
        label: string;
        disabled: boolean;
        onPress: (() => void) | (() => Promise<void>);
    }> | null) => void;
}>) {
    const request = useRequestPersonalHomeBootstrap();
    const onWizardPrimaryChange = props.onWizardPrimaryChange;
    const label = t('setupOnboarding.setupNewRelayAction');
    React.useLayoutEffect(() => {
        onWizardPrimaryChange?.({ label, disabled: request == null, onPress: request ?? (() => undefined) });
        return () => onWizardPrimaryChange?.(null);
    }, [label, onWizardPrimaryChange, request]);

    return (
        <View testID={props.testID}>
            <OrganizationPolicyFieldNotice field="personalHome" />
            <Text>{t('setupOnboarding.relayOnThisComputerSubtitle')}</Text>
            {!onWizardPrimaryChange ? (
                <RoundButton title={label} disabled={!request} onPress={request ?? undefined} />
            ) : null}
        </View>
    );
}
