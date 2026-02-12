import * as React from 'react';
import { View } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/StyledText';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

export function NotSourceControlRepositoryState(): React.ReactElement {
    const { theme } = useUnistyles();

    return (
        <View
            style={{
                flex: 1,
                justifyContent: 'center',
                alignItems: 'center',
                paddingTop: 40,
                paddingHorizontal: 20,
            }}
        >
            <Octicons name="git-branch" size={48} color={theme.colors.textSecondary} />
            <Text
                style={{
                    fontSize: 16,
                    color: theme.colors.textSecondary,
                    textAlign: 'center',
                    marginTop: 16,
                    ...Typography.default(),
                }}
            >
                {t('files.notRepo')}
            </Text>
            <Text
                style={{
                    fontSize: 14,
                    color: theme.colors.textSecondary,
                    textAlign: 'center',
                    marginTop: 8,
                    ...Typography.default(),
                }}
            >
                {t('files.notUnderSourceControl')}
            </Text>
        </View>
    );
}

