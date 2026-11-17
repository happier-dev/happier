import { describe, expect, it } from 'vitest';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SessionTeamCredentialLaunchUnavailableError } from './sessionTeamCredentialLaunchError';

describe('Team credential launch refusal producer', () => {
  it('retains the deciding launch phase when the daemon projects a refusal without a lower-level exception', () => {
    const refusal = new SessionTeamCredentialLaunchUnavailableError('resource_unavailable', 'binding');
    // The same refusal is printed by CLI launch adapters, so its message must
    // give the person an explanation rather than only repeating the wire code.
    expect(refusal.message).not.toBe(refusal.code);
    expect(projectActionFailureCauseV1(refusal)).toMatchObject({
      phase: 'providers.team_credential.binding', errorCode: 'resource_unavailable',
    });
  });

  it('keeps the originating cause rather than relabelling it with the wrapping launch phase', () => {
    const failureCause = projectActionFailureCauseV1(Object.assign(new TypeError('private fixture'), { code: 'ECONNREFUSED' }), 'providers.source_open');
    const refusal = new SessionTeamCredentialLaunchUnavailableError('resource_unavailable', 'binding', { failureCause });
    expect(projectActionFailureCauseV1(refusal)).toEqual(failureCause);
  });
});
