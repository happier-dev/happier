import { describe, expect, it } from 'vitest';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import {
  buildProjectGroupDisplayIndex,
  projectGroupIdentityKey,
  readProjectBaselineRef,
} from './projectGroupDisplay';

const ref = (
  id: string,
  createdAtMs: number,
  extra: Partial<WorkspaceRefV1> = {},
): WorkspaceRefV1 => ({
  id,
  serverId: 'home-a',
  machineId: `m-${id}`,
  rootPath: `/src/${id}`,
  createdAtMs,
  projectKey: 'happier',
  ...extra,
});

describe("one Project's baseline (Space icons read it without building the whole index)", () => {
  it('elects the same baseline the display index elects: oldest ref, then lowest id', () => {
    const refs = [
      ref('b', 20),
      ref('c', 10),
      ref('a', 10),
      ref('other', 1, { projectKey: 'website' }),
    ];
    const project = { serverId: 'home-a', projectKey: 'happier' };
    expect(readProjectBaselineRef(refs, project)?.id).toBe('a');
    expect(readProjectBaselineRef(refs, project)).toBe(
      buildProjectGroupDisplayIndex(refs).get(projectGroupIdentityKey(project))
        ?.baseline,
    );
  });

  it('has no baseline for a Project with no admitted ref on that Home', () => {
    expect(
      readProjectBaselineRef([ref('a', 1)], {
        serverId: 'home-b',
        projectKey: 'happier',
      }),
    ).toBeNull();
  });
});
