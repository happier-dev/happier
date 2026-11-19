import { describe, expect, it } from 'vitest';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SessionTeamCredentialLaunchUnavailableError } from './sessionTeamCredentialLaunchError';

describe('Team credential launch refusal producer', () => {
  const code = 'resource_unavailable';
  const originatingCause = projectActionFailureCauseV1(
    Object.assign(new TypeError('private fixture'), { code: 'ECONNREFUSED' }),
    'providers.source_open',
  );

  it.each([
    {
      description: 'the deciding launch phase without a lower-level exception',
      cause: undefined,
      expectedCause: { phase: 'providers.team_credential.binding', errorClass: 'Error', errorCode: code, httpStatus: null },
    },
    {
      description: 'the originating cause when wrapping a lower-level exception',
      cause: { failureCause: originatingCause },
      expectedCause: originatingCause,
    },
  ])('explains the refusal and preserves $description', ({ cause, expectedCause }) => {
    const refusal = new SessionTeamCredentialLaunchUnavailableError(code, 'binding', cause);

    expect(refusal.code).toBe(code);
    expect(projectActionFailureCauseV1(refusal)).toEqual(expectedCause);
    // CLI launch adapters print this message. It needs readable text beyond the wire code.
    expect(refusal.message.replaceAll(code, '')).toMatch(/\p{L}/u);
  });
});
