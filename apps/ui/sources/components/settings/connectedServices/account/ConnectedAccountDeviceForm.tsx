import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { openExternalUrl } from '@/utils/url/openExternalUrl';

export const ConnectedAccountDeviceForm = React.memo(function ConnectedAccountDeviceForm(props: Readonly<{
    verificationUri?: string;
    verificationUriComplete?: string;
    userCode?: string;
    busy: boolean;
    onPoll(): Promise<void> | void;
    onResume(): Promise<void> | void;
}>) {
    const { theme } = useUnistyles();
    const openUrl = props.verificationUriComplete ?? props.verificationUri ?? '';
    return (
        <>
            <ItemGroup title={t('connectedServices.deviceAuth.userCode')}>
                <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                    <Text
                        testID="connected-account-device:code"
                        selectable
                        style={{ color: theme.colors.text.secondary }}
                    >
                        {props.userCode ?? t('connectedServices.deviceAuth.preparing')}
                    </Text>
                </View>
            </ItemGroup>
            <ItemGroup title={t('connectedServices.deviceAuth.openVerificationUrl')}>
                <View style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 8 }}>
                    <Text selectable style={{ color: theme.colors.text.secondary }}>
                        {props.verificationUri ?? t('connectedServices.deviceAuth.preparing')}
                    </Text>
                    <RoundButton
                        testID="connected-account-device:open"
                        title={t('connectedServices.deviceAuth.openVerificationUrl')}
                        disabled={props.busy || !openUrl}
                        onPress={() => {
                            void openExternalUrl(openUrl);
                        }}
                    />
                </View>
            </ItemGroup>
            <ItemGroup title={t('connectedServices.deviceAuth.waiting')}>
                <View style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 8 }}>
                    <RoundButton
                        testID="connected-account-device:poll"
                        title={t('connectedServices.deviceAuth.polling')}
                        disabled={props.busy}
                        loading={props.busy}
                        onPress={props.onPoll}
                    />
                    <RoundButton
                        testID="connected-account-device:resume"
                        title={t('common.retry')}
                        disabled={props.busy}
                        onPress={props.onResume}
                    />
                </View>
            </ItemGroup>
        </>
    );
});
