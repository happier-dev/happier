import * as React from 'react';
import { View } from 'react-native';

import { getGeneratedAvatarComponentForStyle } from '@/components/ui/avatar/avatarComponentRegistry';
import type { AvatarStyleId } from '@/sync/domains/settings/registry/account/avatarStyleSetting';

export function AvatarStylePreviewIcon(props: Readonly<{ styleId: AvatarStyleId }>) {
    const AvatarStyleComponent = getGeneratedAvatarComponentForStyle(props.styleId);
    return (
        <View style={{ width: 34, height: 34, alignItems: 'center', justifyContent: 'center' }}>
            <AvatarStyleComponent
                id={`settings-avatar-style-preview-${props.styleId}`}
                styleId={props.styleId}
                size={28}
            />
        </View>
    );
}
