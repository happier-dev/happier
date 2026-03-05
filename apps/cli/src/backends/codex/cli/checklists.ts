import type { AgentChecklistContributions } from '@/backends/types';
import { CODEX_ACP_DEP_ID } from '@happier-dev/protocol/installables';

export const checklists = {
  'resume.codex': [
    { id: 'cli.codex', params: { includeLoginStatus: true } },
    { id: CODEX_ACP_DEP_ID, params: { onlyIfInstalled: true, includeRegistry: true } },
  ],
} satisfies AgentChecklistContributions;
