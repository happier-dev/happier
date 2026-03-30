import type { AgentChecklistContributions } from '@/backends/types';

export const checklists = {
  'resume.copilot': [{ id: 'cli.copilot', params: { includeLoginStatus: true } }],
} satisfies AgentChecklistContributions;
