import { describe, expect, it } from 'vitest';
import { WORKFLOW_SESSION_AUTHORING_SELECTION_FIELD_IDS } from '../../workflows/workflowV1.js';
import { EXISTING_SESSION_FIELD_APPLICATIONS } from './existingSessionFieldApplication.js';

describe('existing Session field applications', () => {
  it('classifies every field consumed by workflow reuse, including explicit unsupported reasons', () => {
    expect(Object.keys(EXISTING_SESSION_FIELD_APPLICATIONS).sort()).toEqual([...WORKFLOW_SESSION_AUTHORING_SELECTION_FIELD_IDS].sort());
    expect(EXISTING_SESSION_FIELD_APPLICATIONS.connectedServices).toEqual({ via: 'action', actionId: 'session.connected_services_auth.set' });
    expect(EXISTING_SESSION_FIELD_APPLICATIONS.transcriptStorage).toEqual({ via: 'unsupported', reason: 'new_sessions_only' });
  });
});
