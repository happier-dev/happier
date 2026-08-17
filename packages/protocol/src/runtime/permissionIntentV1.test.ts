import { describe, expect, it } from 'vitest';

import * as Protocol from '../index.js';
import { AgentPermissionIntentV1Schema as AgentSessionPermissionIntentV1Schema } from './agentSessionV1.js';
import { AgentPermissionIntentV1Schema } from './permissionIntentV1.js';
import { SessionInputCausalPermissionAuthorityV1Schema } from '../sessions/messages/sessionInputAdmission.js';

describe('permission intent leaf ownership', () => {
  it('initializes Session admission and runtime configuration through one public intent schema', () => {
    expect(AgentSessionPermissionIntentV1Schema).toBe(AgentPermissionIntentV1Schema);
    expect(SessionInputCausalPermissionAuthorityV1Schema.parse({
      kind: 'admittedSessionInputV1',
      admittedPermissionCeiling: 'default',
      sourceAuthority: {
        kind: 'mediatedExternal',
        mediatorPluginId: 'happier.channels',
        sourceRef: 'binding-1',
        sourceRevisionOrEpoch: 'rev-1',
        admittedPermissionCeiling: 'default',
        remoteApprovalMaxScope: 'request',
      },
    })).toMatchObject({ admittedPermissionCeiling: 'default' });
  });

  it('initializes the public root without re-entering Session admission through the runtime graph', () => {
    expect(Protocol.AgentPermissionIntentV1Schema).toBe(AgentPermissionIntentV1Schema);
    expect(Protocol.AgentPermissionIntentV1Schema.parse('plan')).toBe('plan');
    expect(Protocol.SessionInputCausalPermissionAuthorityV1Schema.parse({
      kind: 'admittedSessionInputV1',
      admittedPermissionCeiling: 'read-only',
    })).toMatchObject({ admittedPermissionCeiling: 'read-only' });
  });
});
