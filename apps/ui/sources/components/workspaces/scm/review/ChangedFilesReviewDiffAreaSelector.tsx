import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import type { ScmDiffArea } from '@happier-dev/protocol';

export function ChangedFilesReviewDiffAreaSelector(props: Readonly<{
    theme: any;
    diffArea: ScmDiffArea;
    availableModes: readonly ScmDiffArea[];
    labels: Readonly<Record<ScmDiffArea, string>>;
    onChange: (area: ScmDiffArea) => void;
}>) {
    const { theme, diffArea, availableModes, labels, onChange } = props;

    if (availableModes.length <= 1) return null;

    return (
        <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 }}>
            {availableModes.map((mode) => (
                <Pressable
                    key={mode}
                    onPress={() => onChange(mode)}
                    style={{
                        paddingVertical: 6,
                        paddingHorizontal: 10,
                        borderRadius: 10,
                        borderWidth: 1,
                        borderColor: theme.colors.divider,
                        backgroundColor: diffArea === mode ? theme.colors.surfaceHigh : theme.colors.surface,
                    }}
                >
                    <Text style={{ fontSize: 12, color: theme.colors.text, ...Typography.default('semiBold') }}>
                        {labels[mode]}
                    </Text>
                </Pressable>
            ))}
        </View>
    );
}
