import {
  MAX_TRIAGE_FAILURE_DETAIL_UTF8_BYTES_V1,
  TriageSourceFailureV1Schema,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import { classifyAzureDevOpsTransportFailure } from './failures.js';
import { createAzureSourceFailure, projectAzureSourceFailure } from './failureProjection.js';

describe('Azure DevOps failure projection', () => {
  it('publishes a multi-line transport message as one line instead of rejecting the result', () => {
    // A transport `Error.message` routinely spans lines. `detail` is a single-line V1
    // string, and the target rejects a control-bearing result ATOMICALLY — so an
    // unnormalized detail discards the scan evidence it was meant to explain.
    const failure = classifyAzureDevOpsTransportFailure({
      error: new Error('socket hang up\n  at TLSSocket.onHangUp'),
      signal: new AbortController().signal,
    });

    const projected = projectAzureSourceFailure(failure);

    expect(projected.detail).toBe('socket hang up at TLSSocket.onHangUp');
    expect(() => TriageSourceFailureV1Schema.parse(projected)).not.toThrow();
  });

  it('publishes a source-local failure detail as one bounded line', () => {
    const projected = createAzureSourceFailure({
      class: 'unsupportedContract',
      code: 'azure-devops/malformed-response',
      detail: `first line\n${'d'.repeat(MAX_TRIAGE_FAILURE_DETAIL_UTF8_BYTES_V1)}`,
    });

    expect(new TextEncoder().encode(projected.detail ?? '').byteLength)
      .toBeLessThanOrEqual(MAX_TRIAGE_FAILURE_DETAIL_UTF8_BYTES_V1);
    expect(() => TriageSourceFailureV1Schema.parse(projected)).not.toThrow();
  });
});
