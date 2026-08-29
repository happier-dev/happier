import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import type { SetupRowState } from '../bootstrap/personalHomeBootstrapTypes';
import { personalHomeCopy } from './personalHomeCopy';

const styles = StyleSheet.create((theme) => ({
    row: {
        minHeight: 56,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        paddingHorizontal: 16,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.background.canvas,
    },
    icon: { width: 28, alignItems: 'center' },
    copy: { flex: 1, gap: 2 },
    title: { ...Typography.default('semiBold'), color: theme.colors.text.primary, fontSize: 15 },
    detail: { ...Typography.default(), color: theme.colors.text.secondary, fontSize: 13 },
}));

const ROW_COPY: Record<SetupRowState['id'], { title: string; detail: string }> = {
    home: {
        title: personalHomeCopy('preparingHomeTitle', 'Preparing your Home'),
        detail: personalHomeCopy('preparingHomeDetail', 'Getting this computer ready for your local work.'),
    },
    app: {
        title: personalHomeCopy('connectingAppTitle', 'Connecting Happier'),
        detail: personalHomeCopy('connectingAppDetail', 'Connecting Happier to your Home securely.'),
    },
    computer: {
        title: personalHomeCopy('preparingComputerTitle', 'Preparing this computer'),
        detail: personalHomeCopy('preparingComputerDetail', 'Setting up the background service so sessions can keep running.'),
    },
};

export const PersonalHomeSetupProgress = React.memo(function PersonalHomeSetupProgress(props: Readonly<{
    rows: readonly SetupRowState[];
}>) {
    const { theme } = useUnistyles();
    return (
        <View testID="personal-home-bootstrap-progress" accessibilityRole="list">
            {props.rows.map((item) => {
                const copy = ROW_COPY[item.id];
                const isActive = item.status === 'active';
                const isBlocked = item.status === 'blocked';
                return (
                    <View
                        key={item.id}
                        testID={`personal-home-bootstrap-row-${item.id}`}
                        accessibilityLiveRegion="polite"
                        style={styles.row}
                    >
                        <View style={styles.icon}>
                            {isActive ? (
                                <ActivitySpinner size="small" color={theme.colors.button.primary.background} />
                            ) : (
                                <Icon
                                    name={isBlocked ? 'warning-circle' : item.status === 'complete' ? 'check-circle' : 'circle'}
                                    size={ICON_SIZE.md}
                                    color={isBlocked ? theme.colors.text.secondary : item.status === 'complete' ? theme.colors.button.primary.background : theme.colors.text.tertiary}
                                    accessibilityLabel={isBlocked ? personalHomeCopy('blocked', 'Needs attention') : undefined}
                                />
                            )}
                        </View>
                        <View style={styles.copy}>
                            <Text style={styles.title}>{copy.title}</Text>
                            <Text style={styles.detail}>{item.detail ?? copy.detail}</Text>
                        </View>
                    </View>
                );
            })}
        </View>
    );
});
