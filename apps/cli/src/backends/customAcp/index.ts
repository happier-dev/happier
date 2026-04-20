import type { AgentCatalogEntry } from '../types';

import { createCustomAcpCompatEntry } from '@/agent/acp/catalog/compat/entry';

export const agent = createCustomAcpCompatEntry() satisfies AgentCatalogEntry;
