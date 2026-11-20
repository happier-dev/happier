import { describe, expect, it } from 'vitest';
import { SessionAuthoringOpenV1Schema } from '@happier-dev/protocol/plugins/ui/hostApiRequests';
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';

import { buildTeamSetupFirstTaskInput } from './teamSetupPlan';

const project = OpenProjectResultV1Schema.parse({ kind: 'opened', setup: 'notRequired', directory: '/home/mara/src/Hello-World',
  workspace: { serverId: 'home', machineId: 'devbox', workspaceId: 'hello', rootPath: '/home/mara/src/Hello-World' } });

describe('Team setup first task', () => {
  // Live bed 11-20: "Start a session" sent prompt '' and the composer owner refused invalid_parameters.
  it('opens an empty draft in the opened checkout when no task text is suggested', () => {
    const input = buildTeamSetupFirstTaskInput({ project: project as never, machineId: 'devbox', prompt: '' });
    expect(SessionAuthoringOpenV1Schema.safeParse(input).success).toBe(true);
  });

  it('carries the Team’s suggested task as the editable prompt', () => {
    const input = buildTeamSetupFirstTaskInput({ project: project as never, machineId: 'devbox', prompt: 'Fix the flaky cart test.' });
    expect(SessionAuthoringOpenV1Schema.safeParse(input).success).toBe(true);
    expect(input.seed.prompt).toBe('Fix the flaky cart test.');
  });
});
