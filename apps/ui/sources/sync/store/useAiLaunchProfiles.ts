import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { getStorage } from '@/sync/domains/state/storageStore';
import { projectAiLaunchProfileForLegacyUi, readUiAiLaunchProfiles } from '@/sync/domains/profiles/aiLaunchProfileCollection';
import { areAccountSettingsScopesEqual, type AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { LaunchProfileArtifactReferenceV1Schema } from '@happier-dev/protocol/launchProfiles/launchProfileArtifactV1';
import type { AiLaunchProfile } from '@happier-dev/protocol/profiles/read';

/** Profile consumers subscribe only to the existing Artifact store's profile documents. */
export function useLaunchProfileArtifacts() {
    return getStorage()(useShallow((state) => Object.fromEntries(Object.entries(state.artifacts)
        .filter(([, artifact]) => artifact.header?.kind === 'launch-profile.v1'))));
}

export function useAiLaunchProfiles(raw: unknown) {
    const scope = getStorage()(useShallow((state) => state.settingsScope));
    return useHomeAiLaunchProfiles(raw, scope);
}

export function useAiLaunchProfilesForLegacyUi(raw: unknown) {
    const profiles = useAiLaunchProfiles(raw);
    return React.useMemo(() => profiles.map(projectAiLaunchProfileForLegacyUi), [profiles]);
}

/** Background-Home readers use the same captured mode-aware store, never the focused Account's rows. */
export function useHomeAiLaunchProfiles(raw: unknown, scope: AccountSettingsScope | null) {
    const artifacts = useLaunchProfileArtifacts();
    const activeScope = getStorage()(useShallow((state) => state.settingsScope));
    const focused = scope !== null && areAccountSettingsScopesEqual(activeScope, scope);
    const needsHydration = focused && (Array.isArray(raw) ? raw : []).some((row) => {
        const reference = LaunchProfileArtifactReferenceV1Schema.safeParse(row);
        if (!reference.success) return false;
        const artifact = artifacts[reference.data.artifactId];
        return !artifact?.isDecrypted || artifact.body === undefined;
    });
    const hydrationBasis = needsHydration ? artifacts : null;
    const [background, setBackground] = React.useState<Readonly<{
        raw: unknown; scope: AccountSettingsScope; profiles: readonly AiLaunchProfile[]; basis: typeof hydrationBasis;
    }> | null>(null);
    React.useEffect(() => {
        if ((focused && !needsHydration) || !scope) return;
        const controller = new AbortController();
        void (async () => {
            const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
            const context = await captureLazyActionAccountContext(scope.serverId, controller.signal);
            try {
                if (context.accountId !== scope.accountId) throw new Error('action_account_scope_changed');
                const profiles = await context.readLaunchProfiles(raw);
                context.assertCurrent();
                if (!controller.signal.aborted) setBackground({ raw, scope, profiles, basis: hydrationBasis });
            } finally { context.dispose(); }
        })().catch(() => { if (!controller.signal.aborted) setBackground(null); });
        return () => controller.abort();
    }, [focused, hydrationBasis, needsHydration, raw, scope]);
    return React.useMemo(() => {
        const opened = focused ? readUiAiLaunchProfiles(raw, artifacts) : [];
        const fetched = background && background.raw === raw && background.basis === hydrationBasis
            && areAccountSettingsScopesEqual(background.scope, scope) ? background.profiles : [];
        if (!focused) return fetched;
        const openedIds = new Set(opened.map((profile) => profile.artifactId).filter(Boolean));
        return [...opened, ...fetched.filter((profile) => profile.artifactId && !openedIds.has(profile.artifactId))];
    }, [artifacts, background, focused, hydrationBasis, raw, scope]);
}
