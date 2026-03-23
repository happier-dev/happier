import type { AgentChecklistContributions } from '@/backends/types';

export const checklists = {
  'resume.codex': [
    { id: 'cli.codex', params: { includeLoginStatus: true } },
  ],
} satisfies AgentChecklistContributions;
