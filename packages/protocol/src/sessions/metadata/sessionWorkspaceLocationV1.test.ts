import { describe, expect, it, vi } from 'vitest';

import {
  buildSessionWorkspaceLocationV1,
  readSessionWorkspaceLocationFromMetadata,
  resolveSessionWorkspaceRootForMachine,
  SessionWorkspaceLocationV1Schema,
} from './sessionWorkspaceLocationV1';
import {
  createSessionOwnerMetadataV1,
  projectSessionOwnerCompatibilityViewV1,
} from './sessionMetadataEnvelopesV1';

describe('sessionWorkspaceLocationV1', () => {
  const location = buildSessionWorkspaceLocationV1({
    machineId: 'machine-1',
    agentPath: '/home/coder/project',
    machinePath: '/Users/alice/project',
  });

  it('does not allocate validation errors for absent optional workspace mappings', () => {
    // Call-through instrumentation: keep the real schema and parsing behavior.
    const parse = vi.spyOn(SessionWorkspaceLocationV1Schema, 'safeParse');
    try {
      for (const metadata of [{}, { sessionWorkspaceLocationV1: undefined }, { sessionWorkspaceLocationV1: null }]) {
        expect(resolveSessionWorkspaceRootForMachine({
          metadata, machineId: 'machine-1', candidatePath: '/home/coder/project',
        })).toEqual({ machinePath: '/home/coder/project' });
      }
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
    expect(readSessionWorkspaceLocationFromMetadata({ metadata: {
      sessionWorkspaceLocationV1: { ...location, machinePath: '   ' },
    } })).toBeNull();
    expect(readSessionWorkspaceLocationFromMetadata({ metadata: {
      sessionWorkspaceLocationV1: { ...location, future: true },
    } })).toEqual({ ...location, future: true });
  });

  it.runIf(process.env.HAPPIER_MEASURE_UI_HOT_LOOPS === '1')('measures ordinary workspace root reads across state updates', () => {
    const metadata = { path: '/home/coder/project' };
    const start = performance.now();
    for (let tick = 0; tick < 20; tick++) {
      for (let index = 0; index < 2_000; index++) {
        const resolved = resolveSessionWorkspaceRootForMachine({
          metadata, machineId: 'machine-1', candidatePath: metadata.path,
        });
        if (resolved.machinePath !== metadata.path) throw new Error('Missing mapping changed the workspace root');
      }
    }
    console.log(JSON.stringify({ measurement: 'absent-workspace-location', sessions: 2_000, ticks: 20,
      elapsedMs: performance.now() - start }));
  });

  it('maps the published agent workspace root only for its owning machine', () => {
    const metadata = { sessionWorkspaceLocationV1: location };

    expect(resolveSessionWorkspaceRootForMachine({
      metadata,
      machineId: 'machine-1',
      candidatePath: '/home/coder/project',
    })).toEqual({
      machinePath: '/Users/alice/project',
      agentPath: '/home/coder/project',
    });
    expect(resolveSessionWorkspaceRootForMachine({
      metadata,
      machineId: 'replacement-machine',
      candidatePath: '/home/coder/project',
    })).toEqual({ machinePath: '/home/coder/project' });
    expect(resolveSessionWorkspaceRootForMachine({
      metadata,
      machineId: 'machine-1',
      candidatePath: '/home/coder/project-other',
    })).toEqual({ machinePath: '/home/coder/project-other' });
  });

  it('recovers an empty root only from a valid same-machine workspace mapping', () => {
    const metadata = { sessionWorkspaceLocationV1: location };
    expect(resolveSessionWorkspaceRootForMachine({ metadata, machineId: 'machine-1', candidatePath: '' }))
      .toEqual({ machinePath: location.machinePath, agentPath: location.agentPath });
    expect(resolveSessionWorkspaceRootForMachine({ metadata, machineId: 'other-machine', candidatePath: '' }))
      .toEqual({ machinePath: '' });
    expect(resolveSessionWorkspaceRootForMachine({
      metadata: { sessionWorkspaceLocationV1: { ...location, machinePath: '' } },
      machineId: 'machine-1', candidatePath: '',
    })).toEqual({ machinePath: '' });
  });

  it('round-trips the predecessor field through Dev owner metadata', () => {
    const created = createSessionOwnerMetadataV1({
      metadata: {
        path: '/home/coder/project',
        host: 'container',
        homeDir: '/home/coder',
        sessionWorkspaceLocationV1: location,
      },
    });

    expect(created).toMatchObject({
      ok: true,
      ownerMetadata: {
        workspace: { sessionWorkspaceLocationV1: location },
      },
    });
    if (!created.ok) return;

    expect(projectSessionOwnerCompatibilityViewV1({
      sharedMetadata: { v: 1 },
      ownerMetadata: created.ownerMetadata,
    }).sessionWorkspaceLocationV1).toEqual(location);
  });
});
