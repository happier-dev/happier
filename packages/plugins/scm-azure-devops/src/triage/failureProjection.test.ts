import {
  MAX_TRIAGE_FAILURE_DETAIL_UTF8_BYTES_V1,
  TriageSourceFailureV1Schema,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import { classifyAzureDevOpsResponse, classifyAzureDevOpsTransportFailure } from './failures.js';
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

  it('keeps provider detail intact until the canonical public failure projection bounds it', () => {
    const providerMessage = '\u{1F680}'.repeat(400);
    const failure = classifyAzureDevOpsResponse({
      status: 500,
      headers: { 'content-type': 'application/json' },
      bodyText: JSON.stringify({ message: providerMessage }),
      nowMs: 1_760_000_000_000,
    });

    if (failure === null) throw new Error('a 500 is not a usable response');
    expect(failure.detail).toBe(providerMessage);

    const projected = projectAzureSourceFailure(failure);
    expect(new TextEncoder().encode(projected.detail ?? '').byteLength)
      .toBeLessThanOrEqual(MAX_TRIAGE_FAILURE_DETAIL_UTF8_BYTES_V1);
    expect(() => TriageSourceFailureV1Schema.parse(projected)).not.toThrow();
  });

  /**
   * `sources/SCM.md` §6.1 sets Azure DevOps Server 2022.1 / REST 7.1 as this vertical's floor and
   * says a deployment that cannot prove it is reported as unsupported rather than sent a
   * speculative mixture of 7.1 and whatever it accepts. The declaration existed; nothing read it.
   * A Server too old to serve the pinned version answers `400` with its own exception type, and
   * that was classified as an ordinary malformed request — which sends an operator hunting a bug
   * in this build instead of upgrading their server.
   */
  it('names an Azure version refusal as unsupported REST rather than an invalid request', () => {
    const failure = classifyAzureDevOpsResponse({
      status: 400,
      headers: { 'content-type': 'application/json' },
      bodyText: JSON.stringify({
        message: 'The requested REST API version of 7.1 is out of range for this server. '
          + 'The latest version this server supports is 6.0.',
        typeKey: 'VssVersionNotSupportedException',
      }),
      nowMs: 1_760_000_000_000,
    });

    if (failure === null) throw new Error('a 400 is not a usable response');
    const projected = projectAzureSourceFailure(failure);
    expect(projected.code).toBe('azure-devops/rest-version-unsupported');
    expect(projected.class).toBe('unsupportedContract');
    // Azure's own message names the highest version this deployment serves; the pinned floor is
    // stated alongside it so an operator can compare the two without another round trip.
    expect(projected.detail).toContain('7.1');
    expect(() => TriageSourceFailureV1Schema.parse(projected)).not.toThrow();
  });

  it('keeps an ordinary Azure 400 an invalid request rather than blaming the server version', () => {
    const failure = classifyAzureDevOpsResponse({
      status: 400,
      headers: { 'content-type': 'application/json' },
      bodyText: JSON.stringify({
        message: 'The value for parameter searchCriteria.status is invalid.',
        typeKey: 'VssPropertyValidationException',
      }),
      nowMs: 1_760_000_000_000,
    });

    if (failure === null) throw new Error('a 400 is not a usable response');
    expect(projectAzureSourceFailure(failure).code).toBe('azure-devops/invalid-request');
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
