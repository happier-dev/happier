import * as React from 'react';
import { View } from 'react-native';


import { Text } from '@/components/ui/text/Text';
import { Icon, type IconName } from '@/components/ui/icons/Icon';

export function renderDropdownItemIcon(params: Readonly<{
    name: IconName;
    color: string;
    size?: number;
}>) {
    return (
        <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
            <Text useDefaultTypography={false}>
                <Icon name={params.name} size={params.size ?? 22} color={params.color} />
            </Text>
        </View>
    );
}
