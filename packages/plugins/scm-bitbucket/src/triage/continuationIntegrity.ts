import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  decodeTriagePagingTokenV1,
  encodeTriagePagingTokenV1,
  type TriageConfiguredSourceConnectedAccountInstanceV1,
} from '@happier-dev/triage-protocol/v1';

const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
let continuationKey: Buffer | null = null;

/** Lazily creates daemon-process custody; importing Action ids in the UI performs no crypto work. */
function readContinuationKey(): Buffer {
  continuationKey ??= randomBytes(32);
  return continuationKey;
}

/** The configured identity and account route shared by every Bitbucket continuation plane. */
export function buildBitbucketContinuationBindingScope(
  instance: TriageConfiguredSourceConnectedAccountInstanceV1,
): string {
  return JSON.stringify([
    instance.instance.source.pluginId,
    instance.instance.source.localId,
    instance.instance.sourceInstanceId,
    instance.binding.purpose,
    instance.binding.account.service.pluginId,
    instance.binding.account.service.localId,
    instance.binding.account.accountId,
  ]);
}

function sign(scope: string, payload: string): string {
  return createHmac('sha256', readContinuationKey())
    .update(scope, 'utf8')
    .update('\0', 'utf8')
    .update(payload, 'utf8')
    .digest('base64url');
}

export function encodeBitbucketContinuationPayload(
  payload: unknown,
  scope: string,
): string | null {
  const encodedPayload = encodeTriagePagingTokenV1(payload);
  if (encodedPayload === null) return null;
  return encodeTriagePagingTokenV1({
    p: encodedPayload,
    s: sign(scope, encodedPayload),
  });
}

export function decodeBitbucketContinuationPayload(
  token: string,
  scope: string,
): Readonly<Record<string, unknown>> | null {
  const envelope = decodeTriagePagingTokenV1(token);
  if (envelope === null || Object.keys(envelope).length !== 2) return null;
  const payload = envelope.p;
  const signature = envelope.s;
  if (
    typeof payload !== 'string'
    || typeof signature !== 'string'
    || !SIGNATURE_PATTERN.test(signature)
  ) {
    return null;
  }
  const expected = Buffer.from(sign(scope, payload), 'base64url');
  const actual = Buffer.from(signature, 'base64url');
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) return null;
  return decodeTriagePagingTokenV1(payload);
}
