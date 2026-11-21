import * as React from 'react';

import { PluginSurfaceProjectionDemand } from '@/components/plugins/surfaces/PluginSurfaceProjectionDemand';
import { SettingsCollectionLayout } from '@/components/settings/shell/SettingsCollectionLayout';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { SKILL_PROJECTION_SECTIONS } from '@/sync/domains/plugins/ui/projectionSections';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';

import { SkillsRail } from './SkillsRail';
import { SKILLS_COLLECTION_ROUTE } from './skillsCollectionModel';

/** The narrowest detail that still fits the skill editor's fields beside their labels. */
const SKILLS_DETAIL_MIN_WIDTH_PX = 480;

function resolveSkillsChildRoute(pathname: string): string {
    if (pathname === SKILLS_COLLECTION_ROUTE) return 'index';
    const rest = pathname.slice(SKILLS_COLLECTION_ROUTE.length + 1);
    return rest === 'new' || rest === 'found' || rest === 'updates' || rest === 'choose' ? rest : '[skillId]';
}

/**
 * Skills as a collection beside the selected detail (P6 §4.1): the homepage at the root, a skill or a
 * new draft beside the list. Narrow: the list page (led by the map) pushes each detail.
 */
export const SkillsSettingsLayout = React.memo(function SkillsSettingsLayout() {
    const enabled = useFeatureEnabled('prompts.library');
    const scope = useAccountSettingsScope();
    if (!enabled) return null;
    return <>
        <PluginSurfaceProjectionDemand accountScope={scope} presents="allInstallations" sections={SKILL_PROJECTION_SECTIONS} />
        <SettingsCollectionLayout
            navigator="skills"
            rootPathname={SKILLS_COLLECTION_ROUTE}
            resolveChildRoute={resolveSkillsChildRoute}
            rail={<SkillsRail variant="rail" />}
            railWidth="detailed"
            detailMinWidthPx={SKILLS_DETAIL_MIN_WIDTH_PX}
            testID="settings-skills"
        />
    </>;
});
