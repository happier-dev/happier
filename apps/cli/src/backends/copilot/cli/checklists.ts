import type { AgentChecklistContributions } from '@/backends/types';

export const checklists = {
  'resume.copilot': [{ id: 'cli.copilot', params: { includeAcpCapabilities: true, includeLoginStatus: true } }],
} satisfies AgentChecklistContributions;
