import * as React from 'react';

import { useCapabilityAddRouteParams } from '@/components/capabilities/add/CapabilityAddModal';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { SKILLS_COLLECTION_ROUTE, skillHref } from '../skillsCollectionModel';
import { openSkillAddModal, type OpenSkillAddModalParams, type SkillAddModeKey } from './openSkillAddModal';

const MODES: readonly SkillAddModeKey[] = ['browse', 'link', 'upload', 'write'];

/**
 * Every Skills entry to Add (rail "+", the phone header, the empty state, the shelf, `?add=` links) opens the same
 * modal; acknowledged Open selects the skill, and Write stays in the modal's draft.
 */
export function useOpenSkillAddModal(): (params?: Readonly<Pick<OpenSkillAddModalParams, 'modeKey' | 'sourceId' | 'query' | 'initialSelection'>>) => void {
    const router = useRouter();
    const go = React.useCallback((href: string) => {
        const result = runGuardedNavigation(() => router.push(href as never));
        if (result !== true) fireAndForget(result, { tag: 'SkillsAdd.open' });
    }, [router]);
    return React.useCallback((params) => {
        openSkillAddModal({
            ...(params ?? {}),
            onAdded: (skillId) => go(skillHref(skillId)),
        });
    }, [go]);
}

/** `/settings/skills?add=browse&q=pdf` opens Add once (P6 §4.4 deep links). */
export function useSkillAddRouteParams(): void {
    const open = useOpenSkillAddModal();
    useCapabilityAddRouteParams((params) => {
        const modeKey = MODES.find((mode) => mode === params.modeKey) ?? 'browse';
        open({ modeKey, ...(params.sourceId ? { sourceId: params.sourceId } : {}), ...(params.query ? { query: params.query } : {}) });
    }, SKILLS_COLLECTION_ROUTE);
}
