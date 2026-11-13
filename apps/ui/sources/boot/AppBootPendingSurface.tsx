import * as React from 'react';

import { STILL_WAITING_AFTER_MS, SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useSurfaceStateElapsedSeconds } from '@/components/ui/surfaces/useSurfaceStateElapsedSeconds';
import { t } from '@/text';
import { isDesktopHost } from '@/utils/platform/desktopHost';

import type { AppBootPhase } from './runAppBootSequence';

/**
 * What the window shows before boot is ready.
 *
 * Nothing, except while a desktop app is still waiting on its saved sign-in after every other
 * prerequisite is ready, for longer than the shared "still waiting" threshold. A signed-in boot
 * spends ~0.1–0.2 s in this phase (measured, P03-DESKTOP-AUTH), so it never flashes; an OS
 * keychain prompt or a locked keychain holds it indefinitely, and a blank window gave no clue
 * that the system was waiting on the person.
 */
export function AppBootPendingSurface(props: Readonly<{ phase: AppBootPhase | null }>): React.ReactElement | null {
    if (props.phase !== 'credentials' || !isDesktopHost()) return null;
    return <CredentialAccessWait />;
}

/** A leaf, so the wait clock never rerenders the boot. */
function CredentialAccessWait(): React.ReactElement | null {
    const elapsedSeconds = useSurfaceStateElapsedSeconds();
    if (elapsedSeconds < STILL_WAITING_AFTER_MS / 1_000) return null;
    return (
        <SurfaceStateCard
            testID="app-boot-credential-access"
            kind="loading"
            size="page"
            title={t('appBoot.credentialAccessTitle')}
            reason={t('appBoot.credentialAccessReason')}
            accessibilitySemantics="status"
        />
    );
}
