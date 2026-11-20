import * as React from 'react';

import { NewAppAutoStep } from '@/components/projects/starters/auto/NewAppAutoStep';
import { SystemTaskProgressCard } from '@/components/systemTasks/SystemTaskProgressCard';
import type {
  SystemTaskEvent,
  SystemTaskRunState,
} from '@/components/systemTasks/types';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageHeader } from '@/components/ui/layout/PageHeader';

export type SetupProgressSpecimenState = 'running' | 'waiting' | 'failed';

const event = (
  tsMs: number,
  type: SystemTaskEvent['type'],
  stepId: string,
  message: string,
) =>
  ({
    protocolVersion: 1,
    taskId: 'specimen-task',
    tsMs,
    type,
    stepId,
    message,
  }) as SystemTaskEvent;

function systemTask(state: SetupProgressSpecimenState): SystemTaskRunState {
  return {
    taskId: 'specimen-task',
    status: state === 'failed' ? 'failed' : 'running',
    currentStepId: 'install.runtime',
    latestMessage:
      state === 'failed' ? 'Installing runtime failed' : 'Installing runtime',
    awaitingInput: state === 'waiting',
    cancelRequested: false,
    events: [
      event(100, 'started', 'prepare', 'Preparing task'),
      event(200, 'progress', 'install.runtime', 'Installing runtime'),
    ],
    result:
      state === 'failed'
        ? {
            ok: false,
            error: {
              code: 'install_failed',
              message: 'The runtime download stopped at 61%.',
            },
          }
        : null,
  } as SystemTaskRunState;
}

/**
 * Dev-only: the progress surfaces that moved onto the shared `PlanChecklistCard` (E1), through their real owners:
 * System Task progress and the new-app suggestion's working step. `?state=running|waiting|failed`. The Machine add
 * panes and agent setup steps have their own specimens (`/dev/add-flows`, `/dev/agent-setup`).
 */
export function SetupProgressSpecimen(
  props: Readonly<{ state: SetupProgressSpecimenState }>,
) {
  const appSteps = [
    {
      key: 'read',
      state: 'done' as const,
      title: 'Read your description',
      meta: '2 s',
    },
    {
      key: 'pick',
      state:
        props.state === 'failed'
          ? ('failed' as const)
          : props.state === 'waiting'
            ? ('waiting' as const)
            : ('running' as const),
      title: 'Choose a starter',
      detail:
        props.state === 'waiting'
          ? 'Answer one question to continue'
          : undefined,
    },
    {
      key: 'scaffold',
      state: 'upcoming' as const,
      title: 'Create the project',
    },
  ];
  return (
    <ItemList>
      <PageHeader
        title="Setup progress"
        description={`Specimen · ${props.state}`}
      />
      <SystemTaskProgressCard
        snapshot={systemTask(props.state)}
        title="Set up this computer"
      />
      <NewAppAutoStep
        view={{
          kind: 'working',
          steps: appSteps,
          runsOn: 'MacBook Pro',
          stop: 'idle',
        }}
        description="A small shop with a cart"
        onDescriptionChange={() => undefined}
        chosenCardId={null}
        onChooseCard={() => undefined}
        onEditDescription={() => undefined}
        onTryAgain={() => undefined}
        onChooseStarter={() => undefined}
        phone={false}
      />
    </ItemList>
  );
}
