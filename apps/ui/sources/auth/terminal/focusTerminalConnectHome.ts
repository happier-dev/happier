import { Platform } from 'react-native';
import type { HomeConnectionDescriptorV1 } from '@happier-dev/protocol/auth/accountDirectory';

import { adoptHomeProfile } from '@/sync/domains/server/serverProfiles';
import { setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';
import { resolveRoutineServerSelectionScope } from '@/sync/domains/server/selection/serverSelectionScope';
import { isDesktopHost } from '@/utils/platform/desktopHost';

/** Install the link's routing hint through the existing Home owners before sign-in. */
export async function focusTerminalConnectHome(params: Readonly<{
    descriptor: HomeConnectionDescriptorV1;
    refreshAuth: () => Promise<void>;
}>) {
    // A pairing link cannot replace an established Home's authoritative descriptor.
    const profile = await adoptHomeProfile({
        descriptor: params.descriptor, source: 'qr', descriptorAuthority: 'advisory', preserveUserLabel: true,
    });
    const switched = await setActiveServerAndSwitch({
        serverId: profile.id,
        scope: resolveRoutineServerSelectionScope(Platform.OS, isDesktopHost()),
        refreshAuth: params.refreshAuth,
    });
    return switched === 'blocked' ? null : profile;
}
