import type { StoredCredentials } from '@/persistence';
import {
  assertSessionMetadataMutationCurrentness,
  type SessionMetadataMutationCurrentness,
} from '@/session/metadata/updateSessionMetadataWithRetry';
import { clearSessionStateFieldFromMetadata } from '@happier-dev/agents/session/state/metadataWriters';

import { updateSessionStateFieldForTarget } from './updateSessionStateFieldForTarget';
import { updateSessionMetadataForTarget } from './updateSessionMetadataForTarget';

export async function setSessionTitle(params: Readonly<{
  credentials: StoredCredentials;
  idOrPrefix: string;
  title: string | null;
  currentness?: SessionMetadataMutationCurrentness;
}>): Promise<Awaited<ReturnType<typeof updateSessionStateFieldForTarget>>> {
  assertSessionMetadataMutationCurrentness(params.currentness);
  if (params.title === null) {
    return await updateSessionMetadataForTarget({
      credentials: params.credentials,
      idOrPrefix: params.idOrPrefix,
      updater: (metadata) => clearSessionStateFieldFromMetadata(metadata, 'display.title'),
      currentness: params.currentness,
    });
  }
  return await updateSessionStateFieldForTarget({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
    fieldId: 'display.title',
    value: {
      title: params.title,
      staleBehavior: 'bump-if-value-changed',
    },
    metadataReason: 'cli-session-title-set',
    currentness: params.currentness,
  });
}
