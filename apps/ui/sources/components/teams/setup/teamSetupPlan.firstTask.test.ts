import { afterEach, describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { SessionAuthoringOpenV1Schema } from '@happier-dev/protocol/plugins/ui/hostApiRequests';
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';

import { readPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

import { buildTeamSetupFirstTaskInput, openTeamSetupFirstTask } from './teamSetupPlan';

const project = OpenProjectResultV1Schema.parse({ kind: 'opened', setup: 'notRequired', directory: '/home/mara/src/Hello-World',
  workspace: { serverId: 'home', machineId: 'devbox', workspaceId: 'hello', rootPath: '/home/mara/src/Hello-World' } });
if (project.kind !== 'opened') throw new Error('Expected an opened checkout');

afterEach(() => retirePresentationNotice());

describe('Team setup first task', () => {
  // Live bed 11-20: "Start a session" sent prompt '' and the composer owner refused invalid_parameters.
  it('opens an empty draft in the opened checkout when no task text is suggested', () => {
    const input = buildTeamSetupFirstTaskInput({ project, machineId: 'devbox', prompt: '' });
    expect(SessionAuthoringOpenV1Schema.safeParse(input).success).toBe(true);
  });

  it('carries the Team’s suggested task as the editable prompt', () => {
    const input = buildTeamSetupFirstTaskInput({ project, machineId: 'devbox', prompt: 'Fix the flaky cart test.' });
    expect(SessionAuthoringOpenV1Schema.safeParse(input).success).toBe(true);
    expect(input.seed.prompt).toBe('Fix the flaky cart test.');
  });

  it('shows a failure if the selected checkout cannot open New Session', async () => {
    const lifetime: ServerAccountScopeLifetime = {
      scope: { serverId: 'home', accountId: 'account' },
      isCurrent: () => true,
      onRetire: () => ({ dispose() {} }),
    };
    const executor = createActionExecutor({ sessionAuthoringOpen: async () => ({ kind: 'unavailable', reason: 'client_unavailable' }) });
    const executeAction = createFrontDoorActionExecute(executor);

    await openTeamSetupFirstTask({
      executeAction,
      context: { surface: 'ui', serverId: 'home', expectedAccountId: 'account' },
      lifetime,
      project,
      machineId: 'devbox',
      prompt: '',
    });

    expect(readPresentationNotice()).toMatchObject({ severity: 'error' });
  });
});
