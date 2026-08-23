import { describe, expect, it } from 'vitest';

import { readScmHostingRepositoryIdentity } from '../scm/hostingRepositoryIdentity.js';
import {
  resolveProjectLaunchPlacementV1,
  type ProjectLaunchPlacementProjectV1,
} from './projectLaunchPlacementV1.js';
import type { WorkspaceRefV1 } from './workspaceRefV1.js';

const REPOSITORY = readScmHostingRepositoryIdentity({
  kind: 'github',
  baseUrl: 'https://github.com',
  nameWithOwner: 'acme/app',
});

function workspaceRef(overrides: Partial<WorkspaceRefV1> = {}): WorkspaceRefV1 {
  return {
    id: 'workspace_1',
    serverId: 'server_1',
    machineId: 'machine_1',
    rootPath: '/home/dev/app',
    label: 'App',
    createdAtMs: 1,
    lastOpenedAtMs: 100,
    ...overrides,
  };
}

function project(input: Readonly<{
  ref?: Partial<WorkspaceRefV1>;
  nameWithOwner?: string | null;
  baseUrl?: string;
  kind?: string;
  reachable?: boolean;
  snapshotAbsent?: boolean;
}>): ProjectLaunchPlacementProjectV1 {
  const ref = workspaceRef(input.ref ?? {});
  if (input.snapshotAbsent) {
    return { workspaceRef: ref, snapshot: null, reachable: input.reachable ?? true };
  }
  return {
    workspaceRef: ref,
    snapshot: {
      hostingProvider: input.nameWithOwner === null
        ? null
        : ({
          id: 'scm.hosting/github',
          kind: (input.kind ?? 'github'),
          displayName: 'GitHub',
          baseUrl: input.baseUrl ?? 'https://github.com',
          nameWithOwner: input.nameWithOwner ?? 'acme/app',
          urlSafety: { allowedSchemes: ['https:'] },
        } as never),
      repo: {
        defaultBranch: 'main',
        worktrees: [
          { path: '/home/dev/app', branch: 'main', isCurrent: true, isMain: true },
          { path: '/home/dev/app-fix', branch: 'fix/1', isCurrent: false },
        ],
      },
    },
    reachable: input.reachable ?? true,
  };
}

describe('resolveProjectLaunchPlacementV1', () => {
  it('launches directly into the single reachable project that resolves to the same repository', () => {
    const placement = resolveProjectLaunchPlacementV1({
      repository: REPOSITORY,
      projects: [
        project({}),
        project({ ref: { id: 'workspace_2', rootPath: '/home/dev/other' }, nameWithOwner: 'acme/other' }),
      ],
    });

    expect(placement).toEqual({
      kind: 'launch',
      candidate: {
        workspaceRefId: 'workspace_1',
        serverId: 'server_1',
        machineId: 'machine_1',
        rootPath: '/home/dev/app',
        label: 'App',
        reachable: true,
        defaultBranch: 'main',
        worktrees: [
          { path: '/home/dev/app', branch: 'main', isCurrent: true, isMain: true },
          { path: '/home/dev/app-fix', branch: 'fix/1', isCurrent: false },
        ],
        lastOpenedAtMs: 100,
      },
    });
  });

  it('prefills instead of guessing when two reachable projects hold the same repository', () => {
    const placement = resolveProjectLaunchPlacementV1({
      repository: REPOSITORY,
      projects: [
        project({ ref: { id: 'workspace_older', machineId: 'machine_2', lastOpenedAtMs: 5 } }),
        project({ ref: { id: 'workspace_newer', lastOpenedAtMs: 900 } }),
      ],
    });

    expect(placement.kind).toBe('prefill');
    expect(placement.kind === 'prefill' && placement.candidates.map((c) => c.workspaceRefId))
      .toEqual(['workspace_newer', 'workspace_older']);
  });

  it('prefills with the unreachable match rather than launching onto an unreachable machine', () => {
    const placement = resolveProjectLaunchPlacementV1({
      repository: REPOSITORY,
      projects: [project({ reachable: false })],
    });

    expect(placement.kind).toBe('prefill');
    expect(placement.kind === 'prefill' && placement.candidates.map((c) => c.reachable)).toEqual([false]);
  });

  it('orders reachable candidates ahead of unreachable ones', () => {
    const placement = resolveProjectLaunchPlacementV1({
      repository: REPOSITORY,
      projects: [
        project({ ref: { id: 'offline', machineId: 'machine_2', lastOpenedAtMs: 900 }, reachable: false }),
        project({ ref: { id: 'online_a', lastOpenedAtMs: 10 } }),
        project({ ref: { id: 'online_b', machineId: 'machine_3', lastOpenedAtMs: 20 } }),
      ],
    });

    expect(placement.kind === 'prefill' && placement.candidates.map((c) => c.workspaceRefId))
      .toEqual(['online_b', 'online_a', 'offline']);
  });

  it('excludes a project whose snapshot resolved no hosting provider, and one with no snapshot at all', () => {
    const placement = resolveProjectLaunchPlacementV1({
      repository: REPOSITORY,
      projects: [
        project({ ref: { id: 'no_provider' }, nameWithOwner: null }),
        project({ ref: { id: 'no_snapshot' }, snapshotAbsent: true }),
      ],
    });

    expect(placement).toEqual({ kind: 'prefill', candidates: [] });
  });

  it('excludes a same-path project that belongs to a different forge deployment', () => {
    const placement = resolveProjectLaunchPlacementV1({
      repository: REPOSITORY,
      projects: [project({ baseUrl: 'https://github.enterprise.example' })],
    });

    expect(placement).toEqual({ kind: 'prefill', candidates: [] });
  });

  it('resolves nothing when the entry itself proves no repository identity', () => {
    const placement = resolveProjectLaunchPlacementV1({
      repository: null,
      projects: [project({})],
    });

    expect(placement).toEqual({ kind: 'prefill', candidates: [] });
  });
});
