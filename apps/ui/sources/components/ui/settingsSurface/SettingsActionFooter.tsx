import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { layout } from '@/components/ui/layout/layout';
import { SplitActionButtons } from '@/components/ui/forms/SplitActionButtons';
import { useSessionCockpitBottomChromeHeight } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';

export const SettingsActionFooter = React.memo(function SettingsActionFooter(props: Readonly<{
    primaryLabel: string;
    onPrimaryPress: () => void;
    primaryDisabled?: boolean;
    primaryTestID?: string;
    secondaryLabel?: string;
    onSecondaryPress?: (() => void) | null;
    secondaryTestID?: string;
    secondaryTone?: 'default' | 'destructive';
    reserveBottomChromeInset?: boolean;
}>) {
    const bottomChromeHeight = useSessionCockpitBottomChromeHeight();

    return (
        <View style={styles.wrapper}>
            <View style={[
                styles.container,
                props.reserveBottomChromeInset && bottomChromeHeight > 0
                    ? { paddingBottom: 16 + bottomChromeHeight }
                    : null,
            ]}>
                <SplitActionButtons
                    secondaryLabel={props.secondaryLabel}
                    onSecondaryPress={props.onSecondaryPress ?? undefined}
                    secondaryTestID={props.secondaryTestID}
                    secondaryDestructive={props.secondaryTone === 'destructive'}
                    primaryLabel={props.primaryLabel}
                    onPrimaryPress={props.onPrimaryPress}
                    primaryDisabled={props.primaryDisabled}
                    primaryTestID={props.primaryTestID}
                />
            </View>
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    wrapper: {
        alignItems: 'center',
    },
    container: {
        width: '100%',
        maxWidth: layout.maxWidth,
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 16,
    },
}));
