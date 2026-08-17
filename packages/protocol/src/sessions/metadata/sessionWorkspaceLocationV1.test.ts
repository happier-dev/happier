import { describe, expect, it } from 'vitest';

import {
  buildSessionWorkspaceLocationV1,
  resolveSessionWorkspaceRootForMachine,
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
