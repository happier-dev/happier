import type { Credentials } from '@/persistence';

import { updateSessionMetadataForTarget } from './updateSessionMetadataForTarget';

export function createSessionTitleMetadataUpdater(params: Readonly<{
  title: string;
  updatedAt?: number;
}>): <TMetadata extends Record<string, unknown>>(metadata: TMetadata) => TMetadata & Readonly<{
  summary: {
    text: string;
    updatedAt: number;
  };
}> {
  const updatedAt = params.updatedAt ?? Date.now();
  return <TMetadata extends Record<string, unknown>>(metadata: TMetadata) => ({
    ...metadata,
    summary: {
      text: params.title,
      updatedAt,
    },
  });
}

export async function setSessionTitle(params: Readonly<{
  credentials: Credentials;
  idOrPrefix: string;
  title: string;
}>): ReturnType<typeof updateSessionMetadataForTarget> {
  return await updateSessionMetadataForTarget({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
    updater: createSessionTitleMetadataUpdater({ title: params.title }),
  });
}
