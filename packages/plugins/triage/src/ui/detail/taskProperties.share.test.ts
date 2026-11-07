import { describe, expect, it } from 'vitest';
import { INTERNAL_TASK_SOURCE_V1, internalTaskLocalRefV1 } from '../../internalTasks/identity.js';
import { readTriageTaskShareRefV1 } from './taskProperties.js';

const viewer = { serverId: 'home-1', accountId: 'viewer-1' };

describe('the task Share… identity', () => {
  it('names the viewer as owner of a personal task and keeps the viewer scope', () => {
    expect(readTriageTaskShareRefV1({ source: INTERNAL_TASK_SOURCE_V1, ...internalTaskLocalRefV1('task-7') }, viewer))
      .toEqual({ taskId: 'task-7', ownerAccountId: 'viewer-1', scope: viewer });
  });
  it('keeps another Account as owner of a task shared with the viewer', () => {
    expect(readTriageTaskShareRefV1({ source: INTERNAL_TASK_SOURCE_V1, ...internalTaskLocalRefV1('task-7', 'owner-2') }, viewer))
      .toEqual({ taskId: 'task-7', ownerAccountId: 'owner-2', scope: viewer });
  });
  it('offers nothing for a source entry or an unknown viewer', () => {
    expect(readTriageTaskShareRefV1({ source: { pluginId: 'happier.scm.forge.github', localId: 'github-forge' },
      kindId: 'issue', collisionScope: 'github:1', entryId: '7' }, viewer)).toBeNull();
    expect(readTriageTaskShareRefV1({ source: INTERNAL_TASK_SOURCE_V1, ...internalTaskLocalRefV1('task-7') }, undefined)).toBeNull();
  });
});
