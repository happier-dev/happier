import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { isHappierCloudServerUrl } from '@happier-dev/cli-common/happierCloud';

import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { HeaderLogo } from '@/components/ui/navigation/HeaderLogo';
import { normalizeAccountDirectoryEndpoint } from '@/sync/domains/accountDirectory/accountDirectoryEndpoint';

export function isDefaultAccountServiceUrl(url: string): boolean {
    const normalized = normalizeAccountDirectoryEndpoint(url);
    // Identity classification, not a default: custom builds must not brand their service as Cloud.
    return normalized !== null && isHappierCloudServerUrl(normalized);
}

/**
 * The mark of a sign-in service: the Happier mark for Happier Cloud, and a plain glyph for any
 * other service (a cloud for a sign-in service, a server for a Home that also offers sign-in).
 */
export const AccountServiceMark = React.memo(function AccountServiceMark(props: Readonly<{
    url: string;
    size?: number;
    /** The mark's box inset (see `HeaderLogo`); a page row passes 0 so its leading column sets the box. */
    inset?: number;
    fallback?: Extract<IconName, 'cloud' | 'hard-drives' | 'globe'>;
}>) {
    const { theme } = useUnistyles();
    const size = props.size ?? 20;
    if (isDefaultAccountServiceUrl(props.url)) return <HeaderLogo size={size} inset={props.inset} />;
    return <Icon name={props.fallback ?? 'cloud'} size={size} color={theme.colors.text.secondary} />;
});
