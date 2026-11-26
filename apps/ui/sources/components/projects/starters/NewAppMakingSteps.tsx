import * as React from 'react';

import { PlanChecklistCard } from '@/components/systemTasks/planChecklist/PlanChecklistCard';
import { projectReportedSteps } from '@/components/systemTasks/planChecklist/projectReportedSteps';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import { keepNewAppFactsTogether } from './keepNewAppFactsTogether';

/**
 * Making (DESIGN-ACCEPT-4 M1): the Thinking step's checklist, on the page column, for the two phases New app awaits —
 * the create Action, then the first message opening. The Action reports no steps of its own, so none are drawn.
 */
export const NewAppMakingSteps = React.memo(function NewAppMakingSteps(
  props: Readonly<{
    /** The create Action answered; the build Session's first message is opening. */
    opening: boolean;
    /** Where the code goes (Code lives on's line), once its owner is known. */
    codeLivesOn: string | null;
  }>,
) {
  const checklist = React.useMemo(
    () =>
      projectReportedSteps([
        {
          key: 'create',
          state: props.opening ? 'done' : 'running',
          title: t('newApp.makingCreate'),
          ...(props.codeLivesOn ? { detail: keepNewAppFactsTogether(props.codeLivesOn) } : {}),
        },
        {
          key: 'open',
          state: props.opening ? 'running' : 'upcoming',
          title: t('newApp.makingOpen'),
        },
      ]),
    [props.codeLivesOn, props.opening],
  );
  return (
    <ItemGroup surface="none" testID="newApp.creating">
      <PlanChecklistCard
        phase="execute"
        {...checklist}
        testID="newApp.making"
      />
    </ItemGroup>
  );
});
