import { createHash } from 'node:crypto';

import type { OpenCodeUsageLimitClassification } from './usageLimit.js';

export type OpenCodeAccountUsageObservation = Readonly<{
  providerId: 'opencode';
  source: 'runtimeSignal';
  confidence: 'subject_provisional';
  accountSubject: Readonly<{
    kind: 'provisionalLocalSubject';
    id: string;
  }>;
  quotaScope: OpenCodeUsageLimitClassification['quotaScope'];
  status: 'limited';
  diagnostic: Readonly<{
    kind: OpenCodeUsageLimitClassification['kind'];
    limitCategory: OpenCodeUsageLimitClassification['limitCategory'];
    providerLimitId: string | null;
    retryAfterMs: number | null;
    resetAtMs: number | null;
    action: OpenCodeUsageLimitClassification['action'];
  }>;
}>;

export type OpenCodeAccountUsageObservationOptions = Readonly<{
  provisionalSubjectDiscriminator: string;
}>;

function hashProvisionalSubject(value: string): string {
  return createHash('sha256')
    .update(`opencode:${value}`)
    .digest('hex')
    .slice(0, 24);
}

function provisionalSubjectId(
  classification: OpenCodeUsageLimitClassification,
  options: OpenCodeAccountUsageObservationOptions,
): string {
  const scope = classification.quotaScope === 'workspace' ? 'workspace' : 'account';
  const providerLimitId = classification.providerLimitId ?? 'unknown_limit';
  return `opencode:${scope}:provisional:${hashProvisionalSubject(`${scope}:${providerLimitId}:${options.provisionalSubjectDiscriminator}`)}`;
}

export function mapOpenCodeUsageLimitToAccountUsageObservation(
  classification: OpenCodeUsageLimitClassification | null,
  options: OpenCodeAccountUsageObservationOptions,
): OpenCodeAccountUsageObservation | null {
  if (!classification) return null;
  return {
    providerId: 'opencode',
    source: 'runtimeSignal',
    confidence: 'subject_provisional',
    accountSubject: {
      kind: 'provisionalLocalSubject',
      id: provisionalSubjectId(classification, options),
    },
    quotaScope: classification.quotaScope,
    status: 'limited',
    diagnostic: {
      kind: classification.kind,
      limitCategory: classification.limitCategory,
      providerLimitId: classification.providerLimitId,
      retryAfterMs: classification.retryAfterMs,
      resetAtMs: classification.resetAtMs,
      action: classification.action,
    },
  };
}
