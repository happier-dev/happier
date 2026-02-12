import type { ComponentProps } from 'react';
import { Ionicons } from '@expo/vector-icons';
import type { ScmBackendId } from '@happier-dev/protocol';

export type ScmBackendSettingsIconName = ComponentProps<typeof Ionicons>['name'];

export type ScmBackendSettingsInfoItem = Readonly<{
    id: string;
    title: string;
    subtitle: string;
    iconName: ScmBackendSettingsIconName;
}>;

export type ScmBackendSettingsPlugin = Readonly<{
    backendId: ScmBackendId;
    title: string;
    description: string;
    infoItems: readonly ScmBackendSettingsInfoItem[];
}>;
