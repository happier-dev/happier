import { describe, expect, it } from 'vitest';
import { buildSessionWorkspaceLocationV1 } from '@happier-dev/protocol/sessions/metadata/sessionWorkspaceLocationV1';

import { resolveSessionMachineWorkspacePath } from './machineControlLocality';

const location = buildSessionWorkspaceLocationV1({
  machineId: 'machine-1', agentPath: '/agent/project', machinePath: '/host/project',
});
const metadata = { sessionWorkspaceLocationV1: location };

describe('resolveSessionMachineWorkspacePath', () => {
  it.each([undefined, '', '  '])('recovers an empty root (%s) only for its recorded machine', candidatePath => {
    expect(resolveSessionMachineWorkspacePath({ metadata, currentMachineId: 'machine-1', candidatePath }))
      .toBe('/host/project');
    expect(resolveSessionMachineWorkspacePath({ metadata, currentMachineId: 'machine-other', candidatePath }))
      .toBeNull();
    expect(resolveSessionMachineWorkspacePath({ metadata, candidatePath })).toBeNull();
  });

  it('preserves an explicit stale root and maps only the current agent root', () => {
    expect(resolveSessionMachineWorkspacePath({ metadata, currentMachineId: 'machine-1', candidatePath: '/stale/project' }))
      .toBe('/stale/project');
    expect(resolveSessionMachineWorkspacePath({ metadata, currentMachineId: 'machine-1', candidatePath: '/agent/project' }))
      .toBe('/host/project');
    expect(resolveSessionMachineWorkspacePath({ metadata, candidatePath: ' /agent/project ' }))
      .toBe('/agent/project');
  });

  it('does not recover an empty path from a malformed mapping', () => {
    expect(resolveSessionMachineWorkspacePath({
      metadata: { sessionWorkspaceLocationV1: { ...location, agentPath: '' } },
      currentMachineId: 'machine-1', candidatePath: '',
    })).toBeNull();
  });
});
