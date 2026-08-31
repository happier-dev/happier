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
    trailingElement?: React.ReactNode;
}>) {
    const { theme, diffArea, availableModes, labels, onChange, trailingElement } = props;

    if (availableModes.length <= 1 && trailingElement == null) return null;

    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                {availableModes.length > 1 ? availableModes.map((mode) => (
                    <Pressable
                        key={mode}
                        onPress={() => onChange(mode)}
                        style={{
                            paddingVertical: 6,
                            paddingHorizontal: 10,
                            borderRadius: 10,
                            borderWidth: 1,
                            borderColor: theme.colors.border.default,
                            backgroundColor: diffArea === mode ? theme.colors.surface.inset : theme.colors.surface.base,
                        }}
                    >
                        <Text style={{ fontSize: 12, color: theme.colors.text.primary, ...Typography.default('semiBold') }}>
                            {labels[mode]}
                        </Text>
                    </Pressable>
                )) : null}
            </View>
            {trailingElement}
        </View>
    );
}
