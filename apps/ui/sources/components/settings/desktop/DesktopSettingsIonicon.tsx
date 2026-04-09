import * as React from 'react';

import { SafeIonicons, type SafeIoniconsName } from '@/components/ui/icons/SafeIonicons';

export type DesktopSettingsIoniconName = SafeIoniconsName;

export type DesktopSettingsIoniconProps = Readonly<{
    name: DesktopSettingsIoniconName;
    size: number;
    color: string;
}>;

export const DesktopSettingsIonicon = React.memo(function DesktopSettingsIonicon(
    props: DesktopSettingsIoniconProps,
) {
    return <SafeIonicons {...props} />;
});
