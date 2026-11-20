import { expect, it } from 'vitest';

import { createProjectAnchorOfKeyV1, createWorkspaceRefResolverV1, workspaceAddressFromRefV2 } from './workspaceRefResolutionV1.js';
import type { WorkspaceRefV1 } from './workspaceRefV1.js';

it('resolves managed addresses from the existing checkout-id bucket without scanning the census', () => {
  const managed: WorkspaceRefV1 = { v: 2, kind: 'managed', id: 'guest', serverId: 'home', managedId: 'native',
    controller: { machineId: 'controller', installationId: 'installed' }, rootPath: '/repo', createdAtMs: 1 };
  const controller: WorkspaceRefV1 = { id: 'local', serverId: 'home', machineId: 'controller', rootPath: '/repo', createdAtMs: 1 };
  const refs = [controller, ...Array.from({ length: 100 }, (_, index) => ({ ...controller, id: `other-${index}`, rootPath: `/other-${index}` })), managed];
  let comparisons = 0;
  const resolve = createWorkspaceRefResolverV1(refs, { normalizeRootPath: path => { comparisons += 1; return path; } });
  comparisons = 0;
  expect(resolve(workspaceAddressFromRefV2(managed))).toEqual({ kind: 'resolved', ref: managed });
  expect(comparisons).toBe(2);
});

it('normalizes each distinct Home identifier once for a Project-anchor census', () => {
  const normalizations = new Map<string, number>();
  const normalizeServerId = (id: string) => {
    normalizations.set(id, (normalizations.get(id) ?? 0) + 1);
    return id.replace('legacy-', 'home-');
  };
  const refs = Array.from({ length: 3_800 }, (_, i) => ({
    id: `checkout-${Math.floor(i / 2)}`,
    serverId: i % 2 === 0 ? 'legacy-a' : 'legacy-b',
    projectKey: `project-${i % 2}-${Math.floor(i / 20)}`,
    machineId: 'machine', rootPath: '/repo', createdAtMs: 0,
  }));
  const anchorOf = createProjectAnchorOfKeyV1(refs, { normalizeServerId });
  for (const ref of refs) {
    expect(anchorOf(ref.serverId, ref.id)).toBe(ref.projectKey);
    expect(anchorOf(ref.serverId.replace('legacy-', 'home-'), ref.id)).toBe(ref.projectKey);
    expect(anchorOf(ref.serverId, ref.projectKey)).toBe(ref.projectKey);
  }
  expect(anchorOf('home-a', 'unknown')).toBe('unknown');
  expect([...normalizations]).toEqual([
    ['legacy-a', 1], ['legacy-b', 1], ['home-a', 1], ['home-b', 1],
  ]);

  // A new census uses the new identity snapshot; no result survives its owner.
  const next = createProjectAnchorOfKeyV1(refs, { normalizeServerId: id => id });
  expect(next('home-a', refs[0]!.id)).toBe(refs[0]!.id);
  expect(next('legacy-a', refs[0]!.id)).toBe(refs[0]!.projectKey);
});
