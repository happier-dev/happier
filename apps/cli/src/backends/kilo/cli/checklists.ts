import type { AgentChecklistContributions } from '@/backends/types';

export const checklists = {
  'resume.kilo': [{ id: 'cli.kilo', params: { includeLoginStatus: true } }],
} satisfies AgentChecklistContributions;
