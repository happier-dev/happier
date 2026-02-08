import type { AgentChecklistContributions } from '@/backends/types';

export const checklists = {
  'resume.kilo': [{ id: 'cli.kilo', params: { includeAcpCapabilities: true, includeLoginStatus: true } }],
} satisfies AgentChecklistContributions;

