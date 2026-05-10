import type { Credentials } from '@/persistence';

import { updateSessionStateFieldForTarget } from './updateSessionStateFieldForTarget';

export async function setSessionTitle(params: Readonly<{
  credentials: Credentials;
  idOrPrefix: string;
  title: string;
}>): ReturnType<typeof updateSessionStateFieldForTarget> {
  return await updateSessionStateFieldForTarget({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
    fieldId: 'display.title',
    value: {
      title: params.title,
      staleBehavior: 'bump-if-value-changed',
    },
    metadataReason: 'cli-session-title-set',
  });
}
