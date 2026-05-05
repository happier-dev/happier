import * as React from 'react';
import { View } from 'react-native';
import { useNavigation, useRouter } from 'expo-router';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Modal } from '@/modal';
import { t } from '@/text';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';

import { useScannedAuthUrlProcessor } from '@/hooks/auth/useScannedAuthUrlProcessor';
import { QrCodeScannerView } from './QrCodeScannerView';

type ScanAuthQrScreenProps = Readonly<{
    allowedUrlKind: 'account' | 'terminal';
    fallbackHref: string;
    title: string;
    subtitle: string;
    permissionRequiredMessage: string;
    manualEntryPromptTitle: string;
    manualEntryPromptDescription?: string;
    manualEntryPlaceholder?: string;
    manualEntryConfirmText: string;
    testIDPrefix: string;
}>;

export function ScanAuthQrScreen(props: ScanAuthQrScreenProps) {
    const router = useRouter();
    const navigation = useNavigation();
    const handleBack = React.useCallback(() => {
        safeRouterBack({ router, navigation, fallbackHref: props.fallbackHref });
    }, [navigation, props.fallbackHref, router]);
    const { processAuthUrl } = useScannedAuthUrlProcessor({
        allowedUrlKind: props.allowedUrlKind,
        onSuccess: handleBack,
    });

    return (
        <QrCodeScannerView
            embedded
            testIDPrefix={props.testIDPrefix}
            title={props.title}
            subtitle={props.subtitle}
            permissionRequiredMessage={props.permissionRequiredMessage}
            onCancel={handleBack}
            onScan={async (data) => {
                if (data.trim()) {
                    await processAuthUrl(data.trim());
                }
            }}
            footer={
                <View style={{ width: '100%', maxWidth: 360 }}>
                    <RoundButton
                        testID={`${props.testIDPrefix}-enter-url`}
                        size="normal"
                        title={t('connect.enterUrlManually')}
                        action={async () => {
                            const url = await Modal.prompt(
                                props.manualEntryPromptTitle,
                                props.manualEntryPromptDescription,
                                {
                                    ...(props.manualEntryPlaceholder ? { placeholder: props.manualEntryPlaceholder } : {}),
                                    confirmText: props.manualEntryConfirmText,
                                    cancelText: t('common.cancel'),
                                },
                            );
                            if (typeof url === 'string' && url.trim()) {
                                await processAuthUrl(url.trim());
                            }
                        }}
                    />
                </View>
            }
        />
    );
}
