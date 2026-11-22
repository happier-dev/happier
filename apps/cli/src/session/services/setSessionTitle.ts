import { resolveCodingPromptSessionTitleInstructionModeV1 } from '@happier-dev/protocol';
import { resolveSessionCodingPromptSettings } from '@/agent/prompting/coding/resolveSessionCodingPromptSettings';
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
  sessionAgentSettings?: Readonly<Record<string, unknown>>;
}>): ReturnType<typeof updateSessionMetadataForTarget> {
  const { sessionAgentSettings } = params;
  return await updateSessionMetadataForTarget({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
    updater: sessionAgentSettings
      ? createSessionAgentTitleMetadataUpdater({ title: params.title, readSettings: () => sessionAgentSettings })
      : createSessionTitleMetadataUpdater({ title: params.title }),
  });
}

export class SessionAgentTitleUpdateDenied extends Error {
  readonly code = 'session_title_updates_disabled';
  readonly retryable = false;

  constructor() {
    super('session_title_updates_disabled');
  }
}

export function createSessionAgentTitleMetadataUpdater(params: Readonly<{
  title: string;
  readSettings: () => Readonly<Record<string, unknown>>;
}>): <TMetadata extends Record<string, unknown>>(metadata: TMetadata) => TMetadata {
  const updateTitle = createSessionTitleMetadataUpdater(params);
  return (current) => {
    const settings = resolveSessionCodingPromptSettings({ settings: params.readSettings(), profileId: typeof current.profileId === 'string' ? current.profileId : null });
    if (resolveCodingPromptSessionTitleInstructionModeV1(settings, current) === 'disabled') {
      throw new SessionAgentTitleUpdateDenied();
    }
    return updateTitle(current);
  };
}
