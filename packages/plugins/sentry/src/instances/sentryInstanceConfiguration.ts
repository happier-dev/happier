/**
 * The strict source-private configured-instance codecs (`SENTRY.md` §2.4).
 *
 * Two carriers, deliberately disjoint:
 *
 * - the **configuration token** holds only what the aggregate must preserve and
 *   never parse: organization id and the two fixed V1 query scopes. It carries
 *   no deployment origin, because a second origin authority can go stale after
 *   an explicit reconfiguration.
 * - the **`localInstanceKey`** holds exactly the routing/identity pair
 *   `<normalized deploymentOrigin> U+001F <organizationId>`. It is the only place
 *   the expected origin survives, and a malformed key never routes.
 */

import { MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1 } from '@happier-dev/triage-protocol/v1';

import { SENTRY_SCOPE_SEPARATOR } from '../sentryContracts.js';

import { normalizeSentryOrigin } from '../auth/sentryOrigin.js';
import { isSentryNumericId, type SentryInvokedInstanceV1 } from './sentryCollisionScope.js';

export type SentryInstanceConfigurationV1 = Readonly<{
  v: 1;
  organizationId: string;
  projectScope: Readonly<{ kind: 'allAccessible' }>;
  environmentScope: Readonly<{ kind: 'all' }>;
}>;

export type SentryInstanceConfigurationResultV1 =
  | Readonly<{ ok: true; configuration: SentryInstanceConfigurationV1 }>
  | Readonly<{ ok: false }>;

export type SentryLocalInstanceKeyResultV1 =
  | Readonly<{ ok: true; instance: SentryInvokedInstanceV1 }>
  | Readonly<{ ok: false }>;

const REJECTED = Object.freeze({ ok: false as const });

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function encodeSentryInstanceConfiguration(
  configuration: SentryInstanceConfigurationV1,
): string {
  if (configuration.v !== 1) {
    throw new Error('Only version 1 Sentry instance configuration can be encoded.');
  }
  if (!isSentryNumericId(configuration.organizationId)) {
    throw new Error('A Sentry instance configuration requires the numeric organization id.');
  }
  if (
    configuration.projectScope.kind !== 'allAccessible'
    || configuration.environmentScope.kind !== 'all'
  ) {
    throw new Error('V1 fixes the Sentry project and environment scopes.');
  }
  const token = JSON.stringify({
    v: 1,
    organizationId: configuration.organizationId,
    projectScope: { kind: 'allAccessible' },
    environmentScope: { kind: 'all' },
  });
  if (new TextEncoder().encode(token).byteLength > MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1) {
    throw new Error('The Sentry instance configuration exceeds the bounded token size.');
  }
  return token;
}

export function decodeSentryInstanceConfiguration(
  token: string,
): SentryInstanceConfigurationResultV1 {
  if (new TextEncoder().encode(token).byteLength > MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1) {
    return REJECTED;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(token);
  } catch {
    return REJECTED;
  }
  if (!isRecord(parsed) || parsed.v !== 1) return REJECTED;
  const { organizationId, projectScope, environmentScope } = parsed;
  if (typeof organizationId !== 'string' || !isSentryNumericId(organizationId)) return REJECTED;
  if (!isRecord(projectScope) || projectScope.kind !== 'allAccessible') return REJECTED;
  if (!isRecord(environmentScope) || environmentScope.kind !== 'all') return REJECTED;
  return Object.freeze({
    ok: true as const,
    configuration: Object.freeze({
      v: 1 as const,
      organizationId,
      projectScope: Object.freeze({ kind: 'allAccessible' as const }),
      environmentScope: Object.freeze({ kind: 'all' as const }),
    }),
  });
}

export function encodeSentryLocalInstanceKey(instance: SentryInvokedInstanceV1): string {
  const normalized = normalizeSentryOrigin(instance.deploymentOrigin);
  if (!normalized.ok || normalized.origin !== instance.deploymentOrigin) {
    throw new Error('A Sentry localInstanceKey requires an already-normalized canonical origin.');
  }
  if (!isSentryNumericId(instance.organizationId)) {
    throw new Error('A Sentry localInstanceKey requires the numeric organization id.');
  }
  return `${normalized.origin}${SENTRY_SCOPE_SEPARATOR}${instance.organizationId}`;
}

export function decodeSentryLocalInstanceKey(key: string): SentryLocalInstanceKeyResultV1 {
  const parts = key.split(SENTRY_SCOPE_SEPARATOR);
  if (parts.length !== 2) return REJECTED;
  const [rawOrigin = '', organizationId = ''] = parts;
  const normalized = normalizeSentryOrigin(rawOrigin);
  if (!normalized.ok || normalized.origin !== rawOrigin) return REJECTED;
  if (!isSentryNumericId(organizationId)) return REJECTED;
  return Object.freeze({
    ok: true as const,
    instance: Object.freeze({ deploymentOrigin: normalized.origin, organizationId }),
  });
}
