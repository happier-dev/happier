import type { AgentCatalogEntry } from '../types';

import { createBuiltInEntry } from '@/agent/acp/catalog/builtIn/entry';

export const agent = createBuiltInEntry('kiro') satisfies AgentCatalogEntry;
