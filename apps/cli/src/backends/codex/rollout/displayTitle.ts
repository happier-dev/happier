import type { SessionStateProviderFieldHandler } from '@happier-dev/agents';

import { readCodexSessionTitleFromRollout } from './readCodexSessionTitleFromRollout';

export function createCodexRolloutDisplayTitleHandler(params: Readonly<{
  rolloutFilePath: string;
}>): SessionStateProviderFieldHandler<'display.title'> {
  return {
    readField: async () => await readCodexSessionTitleFromRollout(params.rolloutFilePath),
  };
}
