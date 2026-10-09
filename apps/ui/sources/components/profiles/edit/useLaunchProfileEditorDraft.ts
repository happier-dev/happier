import * as React from 'react';
import { isBuiltInAiLaunchProfileV1, isLaunchProfileV2, type AiLaunchProfile } from '@happier-dev/protocol/profiles/read';
import type { ProfileLegacyCloneSourceV1, ProfileRecordV1 } from '@happier-dev/protocol/profiles/profileRecordV1';

import { createEmptyCustomProfile, duplicateProfileDraftForEdit } from '@/sync/domains/profiles/profileMutations';
import { getBuiltInProfile } from '@/sync/domains/profiles/profileUtils';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { useAiLaunchProfiles } from '@/sync/store/useAiLaunchProfiles';
import { useProfileCatalog } from '@/sync/store/useProfileCatalog';
import { t } from '@/text';

type EditorDraft = Readonly<{ status: 'ready'; profile: AiLaunchProfile; secretBindings?: ProfileRecordV1['secretBindings']; legacyCloneSource?: ProfileLegacyCloneSourceV1 }>
    | Readonly<{ status: 'migration'; profile: Exclude<AiLaunchProfile, { v: 2 }>; sourceRevision?: number }>
    | Readonly<{ status: 'loading' | 'idle' | 'discarded' }>
    | Readonly<{ status: 'unavailable'; reason: string }>;

/** Capture a detached draft once its source is authoritative; refreshes never replace user edits. */
export function useLaunchProfileEditorDraft(options: Readonly<{ enabled: boolean; cloneFrom: string | null; saveAsBuiltin?: boolean }>) {
    const scope = useAccountSettingsScope();
    const projection = useProfileCatalog(scope);
    const catalog = projection?.catalog;
    const profiles = useAiLaunchProfiles();
    const source = options.cloneFrom ? profiles.find(profile => profile.id === options.cloneFrom)
        ?? getBuiltInProfile(options.cloneFrom) : null;
    const key = JSON.stringify([scope?.serverId, scope?.accountId, options.enabled, options.cloneFrom, options.saveAsBuiltin]);
    const initialize = (resumeMigration = false): EditorDraft => {
        if (!options.enabled) return { status: 'idle' };
        if (!scope) return { status: 'loading' };
        if (!options.cloneFrom) return { status: 'ready', profile: createEmptyCustomProfile() };
        if (!catalog || catalog.status === 'loading') return { status: 'loading' };
        if (catalog.status !== 'ready' || catalog.source !== 'destination') return {
            status: 'unavailable', reason: catalog.status === 'unavailable' ? catalog.reason : 'profile_catalog_unavailable',
        };
        if (!source) return { status: 'unavailable', reason: 'profile-not-found' };
        if (options.saveAsBuiltin && !resumeMigration && !isBuiltInAiLaunchProfileV1(source)) return { status: 'idle' };
        const sourceRow = catalog.records.find(row => row.record.id === source.id);
        const result = duplicateProfileDraftForEdit(source, { copySuffix: t('profiles.copySuffix'),
            sourceRow, artifactsById: projection?.artifactsById });
        if (result.status !== 'draft' && result.reason === 'legacy-creation-unsupported' && !isLaunchProfileV2(source))
            return { status: 'migration', profile: source, sourceRevision: sourceRow?.revision };
        return result.status === 'draft' ? { status: 'ready', profile: result.profile, secretBindings: result.secretBindings,
            legacyCloneSource: result.legacyCloneSource }
            : { status: 'unavailable', reason: result.reason };
    };
    const [captured, setCaptured] = React.useState(() => ({ key, draft: initialize() }));
    React.useEffect(() => {
        if (captured.key === key && ['ready', 'idle', 'discarded'].includes(captured.draft.status)) return;
        const draft = initialize(captured.key === key && captured.draft.status === 'migration');
        if (captured.key === key && (draft.status === 'loading' && captured.draft.status === 'loading'
            || draft.status === 'unavailable' && captured.draft.status === 'unavailable'
                && draft.reason === captured.draft.reason
            || draft.status === 'migration' && captured.draft.status === 'migration'
                && draft.profile.id === captured.draft.profile.id && draft.sourceRevision === captured.draft.sourceRevision
                && draft.profile.artifactId === captured.draft.profile.artifactId
                && draft.profile.revision?.headerVersion === captured.draft.profile.revision?.headerVersion
                && draft.profile.revision?.bodyVersion === captured.draft.profile.revision?.bodyVersion)) return;
        setCaptured({ key, draft });
    }, [captured, key, catalog, source, projection?.artifactsById]);
    const discard = React.useCallback(() => setCaptured({ key, draft: { status: 'discarded' } }), [key]);
    return { draft: captured.key === key ? captured.draft : { status: 'loading' } as const, discard };
}
