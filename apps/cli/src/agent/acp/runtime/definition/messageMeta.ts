import type { ProviderMessageMetaEnricher } from '@happier-dev/agents';

import type { AcpRuntimeDefinition } from './_types';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return isRecord(value) && typeof value.then === 'function';
}

export function createProviderMessageMetaEnricher(params: Readonly<{
  backendId: string;
  messageMeta: AcpRuntimeDefinition['messageMeta'];
}>): ProviderMessageMetaEnricher | undefined {
  const { backendId, messageMeta } = params;
  const enrich = messageMeta?.enrichOutgoing;
  if (!enrich) {
    return undefined;
  }

  return Object.freeze({
    buildOutgoingMessageMetaExtras(params) {
      const enriched = enrich(params, undefined);
      if (isPromiseLike(enriched)) {
        throw new Error(`ACP backend '${backendId}' messageMeta.enrichOutgoing returned a Promise; A.15.2 supports synchronous outgoing message metadata only.`);
      }
      if (!isRecord(enriched)) {
        return {};
      }
      return Object.freeze({ ...enriched });
    },
  });
}
