import { AGENTS_CORE } from '@happier-dev/agents';

import type { AgentCatalogEntry } from '../types';

export const agent = {
  id: AGENTS_CORE.codex.id,
  cliSubcommand: AGENTS_CORE.codex.cliSubcommand,
  vendorResumeSupport: AGENTS_CORE.codex.resume.vendorResume,
} satisfies AgentCatalogEntry;
