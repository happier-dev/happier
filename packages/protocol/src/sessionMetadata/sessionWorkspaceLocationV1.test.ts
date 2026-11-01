import { describe, expect, it } from 'vitest';

import {
  SessionWorkspaceLocationV1Schema,
  buildSessionWorkspaceLocationV1,
  readSessionWorkspaceLocationFromMetadata,
  resolveSessionWorkspaceRootForMachine,
} from './sessionWorkspaceLocationV1';

describe('sessionWorkspaceLocationV1', () => {
  const location = {
    v: 1 as const,
    machineId: 'machine-1',
    agentPath: '/home/coder/project',
    machinePath: '/Users/alice/project',
  };

  it('publishes and reads the complete agent-to-machine workspace mapping', () => {
    expect(buildSessionWorkspaceLocationV1({
      machineId: 'machine-1',
      agentPath: '/home/coder/project',
      machinePath: '/Users/alice/project',
    })).toEqual(location);
    expect(SessionWorkspaceLocationV1Schema.parse(location)).toEqual(location);
    expect(readSessionWorkspaceLocationFromMetadata({
      metadata: { sessionWorkspaceLocationV1: location },
    })).toEqual(location);
  });

  it('ignores malformed mappings without hiding otherwise valid metadata', () => {
    expect(readSessionWorkspaceLocationFromMetadata({
      metadata: {
        sessionWorkspaceLocationV1: {
          ...location,
          machinePath: '',
        },
        path: location.agentPath,
      },
    })).toBeNull();
  });

  it('translates only the exact agent root bound to the target machine', () => {
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
      candidatePath: '/home/coder/other-project',
    })).toEqual({ machinePath: '/home/coder/other-project' });
  });

  it('recovers a missing root only from a valid mapping for the target machine', () => {
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
});
