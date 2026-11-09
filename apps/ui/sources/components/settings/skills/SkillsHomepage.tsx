import * as React from 'react';
import { useHappierCollectionIndexView } from '@happier-dev/plugin-ui/presentation';

import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useRegistrySuggestions } from '@/registries/useRegistrySuggestions';
import { useReachMachines } from '@/sync/domains/capabilities/reach/useReachProjection';
import { useSkillsLibrary, type SkillsLibrary } from '@/sync/domains/skills/useSkillsLibrary';

import { SkillsList } from './SkillsRail';
import { SkillsHomeOverview } from './SkillsHomeOverview';
import { SkillsRegistryShelf } from './SkillsRegistryShelf';
import { hasOwnSkills } from './skillsCollectionModel';
import { useSkillsFirstRun } from './firstRun/useSkillsFirstRun';
import { SkillsFoundBlock } from './found/SkillsFoundBlock';

/** Wide roots show the home; phone roots compose its overview into the single collection scroll. */
export const SkillsSettingsIndex = React.memo(function SkillsSettingsIndex() {
  const view = useHappierCollectionIndexView();
  const library = useSkillsLibrary();
  if (view === 'pending') return null;
  if (view === 'land') return <SkillsHomepage library={library} />;
  return <SkillsList variant="page" library={library} />;
});

export const SkillsHomepage = React.memo(function SkillsHomepage(props: Readonly<{ library: SkillsLibrary }>) {
  return (
    <ItemList pageColumn="wide">
      <PageContentColumn>
        <SkillsHomeOverview library={props.library} />
        <SkillsHomepageRecommendations library={props.library} />
      </PageContentColumn>
    </ItemList>
  );
});

/** Only the displayed desktop recommendations acquire their catalog; phone reach does not. */
function SkillsHomepageRecommendations(props: Readonly<{ library: SkillsLibrary }>) {
  const { library } = props;
  const loading = library.status === 'loading' && library.items.length === 0;
  const unavailable = library.status === 'unavailable' && library.items.length === 0;
  const shelf = useRegistrySuggestions('skill', { enabled: !loading && !unavailable });
  const { machines } = useReachMachines();
  const { firstVisit } = useSkillsFirstRun(library.items);
  if (loading || unavailable) return null;
  return (
    <>
      <SkillsRegistryShelf library={library} shelf={shelf} brandNew={!hasOwnSkills(library.items)} />
      {firstVisit ? null : <SkillsFoundBlock machines={machines} />}
    </>
  );
}

