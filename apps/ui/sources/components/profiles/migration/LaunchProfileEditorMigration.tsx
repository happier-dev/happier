import * as React from 'react';
import type { AIBackendProfile } from '@happier-dev/protocol/profiles/backendProfileSchema';

import { useProviderSettings } from '@/providers/hooks/useProviderSettings';
import { refreshProfileCatalog } from '@/sync/engine/settings/profileCatalogEngine';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';

import { LegacyProfileMigrationConflictFlow } from './LegacyProfileMigrationConflictFlow';
import { LegacyProfileMigrationFlow } from './LegacyProfileMigrationFlow';
import { resolveProfileMigrationConflict } from './status';

/** Resume the editor draft only from the acknowledged, rehydrated migration source. */
export const LaunchProfileEditorMigration = React.memo(function LaunchProfileEditorMigration(props: Readonly<{
    profile: AIBackendProfile;
    onCancel: () => void;
}>) {
    const scope = useAccountSettingsScope();
    const providerSettings = useProviderSettings();
    const acknowledged = React.useRef(false);
    const rehydrate = React.useCallback(async (minimumVersion: number) => {
        await getSyncSingleton().refreshAccountSettingsFromServer(minimumVersion, scope);
        if (!scope) throw new Error('profile_account_unavailable');
        await refreshProfileCatalog(scope);
        acknowledged.current = true;
    }, [scope]);
    const close = React.useCallback(() => {
        if (!acknowledged.current) props.onCancel();
    }, [props.onCancel]);
    const conflict = resolveProfileMigrationConflict({ profileId: props.profile.id, providerSettings });
    return conflict ? <LegacyProfileMigrationConflictFlow profileName={props.profile.name} conflict={conflict}
        rehydrateSettings={rehydrate} onClose={close} />
        : <LegacyProfileMigrationFlow profile={props.profile} secretBindings={props.profile.secretBindings ?? {}}
            rehydrateSettings={rehydrate} onClose={close} />;
});
