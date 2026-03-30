import type { AgentChecklistContributions } from '@/backends/types';

export const checklists = {
  'resume.auggie': [{ id: 'cli.auggie', params: { includeLoginStatus: true } }],
} satisfies AgentChecklistContributions;
