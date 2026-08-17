import type { ComponentProps } from 'react';
import type { PluginContributionIdentityV1, ScmBackendId } from '@happier-dev/protocol';
import type { IconName } from '@/components/ui/icons/Icon';

export type ScmBackendSettingsIconName = IconName;

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

export type ScmHostingProviderSettingsPlugin = Readonly<{
    providerId: string;
    serviceId: string | null;
    title: string;
    description: string;
    kind: string | null;
    authService: PluginContributionIdentityV1 | null;
}>;
