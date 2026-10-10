import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

export const UnifiedDiffFoldToggleRow = React.memo(function UnifiedDiffFoldToggleRow(props: Readonly<{
    hiddenCount: number;
    onPressExpand: () => void;
}>) {
    const { theme } = useUnistyles();
    const paintColor = useHappierMaterialColorResolver();
    const count = Math.max(0, Math.floor(props.hiddenCount));

    return (
        <View style={{ paddingLeft: 46, paddingRight: 8, paddingVertical: 6 }}>
            <Pressable
                onPress={props.onPressExpand}
                accessibilityRole="button"
                style={{
                    alignSelf: 'flex-start',
                    paddingHorizontal: 10,
                    paddingVertical: 6,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: theme.colors.border.default,
                    backgroundColor: paintColor(theme.colors.surface.inset),
                }}
            >
                <Text
                    style={{
                        ...Typography.default('semiBold'),
                        fontSize: 12,
                        color: theme.colors.text.secondary,
                    }}
                >
                    {t('find.showHiddenLines', { count })}
                </Text>
            </Pressable>
        </View>
    );
});
