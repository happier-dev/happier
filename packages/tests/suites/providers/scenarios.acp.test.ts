import { describe, expect, it } from 'vitest';

import {
  makeAcpPermissionOutsideWorkspaceScenario,
  makeAcpResumeLoadSessionScenario,
} from '../../src/testkit/providers/scenarios.acp';

describe('providers: ACP scenario builders (smoke)', () => {
  it('builds representative permission and resume scenarios', () => {
    const permission = makeAcpPermissionOutsideWorkspaceScenario({
      providerId: 'opencode',
      content: 'SMOKE',
      decision: 'approve',
    });
    const resume = makeAcpResumeLoadSessionScenario({
      providerId: 'opencode',
      metadataKey: 'opencodeSessionId',
      phase1TraceSentinel: 'PHASE1',
      phase2TraceSentinel: 'PHASE2',
    });

    expect(permission.id).toBe('permission_surface_outside_workspace');
    expect(resume.id).toBe('acp_resume_load_session');
  });
});
