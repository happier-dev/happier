import { describe, expect, it } from 'vitest';

import {
  createConnectedServiceAuthGenerationApplyFailureError,
  readConnectedServiceAuthGenerationApplyFailure,
} from './connectedServiceAuthGenerationApplyFailure';

describe('credential revision apply failure classification', () => {
  it.each(['credential_revision_missing', 'credential_revision_superseded'])(
    'preserves %s as retryable when crossing the apply error boundary', (errorCode) => {
      const failure = readConnectedServiceAuthGenerationApplyFailure(
        createConnectedServiceAuthGenerationApplyFailureError({ errorCode }),
      );
      expect(failure).toMatchObject({ errorCode, retryable: true });
    },
  );
});
