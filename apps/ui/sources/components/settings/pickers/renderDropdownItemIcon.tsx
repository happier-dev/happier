import * as React from 'react';
import { View } from 'react-native';

import { Ionicons } from '@expo/vector-icons';

import { Text } from '@/components/ui/text/Text';

export function renderDropdownItemIcon(params: Readonly<{
    name: React.ComponentProps<typeof Ionicons>['name'];
    color: string;
    size?: number;
}>) {
    return (
        <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
            <Text useDefaultTypography={false}>
                <Ionicons name={params.name} size={params.size ?? 22} color={params.color} />
            </Text>
        </View>
    );
}
