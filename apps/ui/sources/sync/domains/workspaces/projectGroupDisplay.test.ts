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

  it('distinguishes same-named Projects using their admitted checkout locations', () => {
    const first = ref('a', 1, { projectKey: 'first', rootPath: '/work/happier-dev' });
    const second = ref('b', 1, { projectKey: 'second', rootPath: '/sandbox/happier-dev' });
    const unique = ref('c', 1, { projectKey: 'third', rootPath: '/work/website' });
    const displays = buildProjectGroupDisplayIndex([first, second, unique]);
    expect([...displays.values()].map(display => display.title)).toEqual([
      'happier-dev · /work/happier-dev',
      'happier-dev · /sandbox/happier-dev',
      'website',
    ]);
  });

  it('uses Machine names for identical checkout paths and keeps ids out of group titles', () => {
    const first = ref('a', 1, { projectKey: 'private-key-a', rootPath: '/work/happier-dev' });
    const second = ref('b', 1, { projectKey: 'private-key-b', rootPath: '/work/happier-dev' });
    const displays = buildProjectGroupDisplayIndex([first, second], [], { 'm-a': 'Dev box', 'm-b': 'Sandbox' });
    expect([...displays.values()].map(display => display.title)).toEqual([
      'happier-dev · Dev box',
      'happier-dev · Sandbox',
    ]);
    expect([...buildProjectGroupDisplayIndex([second, first]).values()].map(display => display.title)).toEqual([
      'happier-dev · 2',
      'happier-dev · 1',
    ]);
  });
});
