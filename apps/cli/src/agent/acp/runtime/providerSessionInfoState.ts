import {
  ProviderSessionInfoV1Schema,
  hasSessionTitleInMetadata,
  type ProviderSessionInfoV1,
} from '@happier-dev/protocol';

import type { Metadata } from '@/api/types';

export type ProviderSessionInfoUpdate = Readonly<{
  title?: string | null;
  updatedAt?: string | null;
}>;

function hasOwn(record: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function applyProviderSessionInfoUpdate(params: Readonly<{
  metadata: Metadata;
  provider: string;
  sessionId: string;
  observedAt: number;
  update: ProviderSessionInfoUpdate;
}>): Metadata {
  const currentParse = ProviderSessionInfoV1Schema.safeParse(params.metadata.providerSessionInfoV1);
  const current = currentParse.success ? currentParse.data : undefined;
  const sameSession = current?.provider === params.provider && current.sessionId === params.sessionId;
  const candidate: ProviderSessionInfoV1 = {
    v: 1,
    provider: params.provider,
    sessionId: params.sessionId,
    observedAt: params.observedAt,
    ...(sameSession && current && hasOwn(current, 'title') ? { title: current.title } : {}),
    ...(sameSession && current && hasOwn(current, 'updatedAt') ? { updatedAt: current.updatedAt } : {}),
    ...(hasOwn(params.update, 'title') ? { title: params.update.title } : {}),
    ...(hasOwn(params.update, 'updatedAt') ? { updatedAt: params.update.updatedAt } : {}),
  };
  const parsed = ProviderSessionInfoV1Schema.safeParse(candidate);
  if (!parsed.success) return params.metadata;

  const providerTitle = parsed.data.title;
  const shouldInitializeTitle = !hasSessionTitleInMetadata(params.metadata)
    && typeof providerTitle === 'string'
    && providerTitle.length > 0;

  return {
    ...params.metadata,
    providerSessionInfoV1: parsed.data,
    ...(shouldInitializeTitle
      ? { summary: { text: providerTitle, updatedAt: params.observedAt } }
      : {}),
  };
}
