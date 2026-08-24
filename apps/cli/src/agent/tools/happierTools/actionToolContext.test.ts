import { getActionSpec } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';
import { projectSessionBoundActionToolInputSchema } from './actionToolContext';

describe('session-bound Action tool context', () => {
  it('optionalizes only the built-in fields whose declared host context is available', () => {
    const search = projectSessionBoundActionToolInputSchema({
      actionId: 'memory.search',
      inputSchema: getActionSpec('memory.search').inputSchema,
      context: { defaultSessionId: 'current-session', defaultSessionMachineId: 'machine-1' },
    }) as z.ZodType;
    const window = projectSessionBoundActionToolInputSchema({
      actionId: 'memory.get_window',
      inputSchema: getActionSpec('memory.get_window').inputSchema,
      context: { defaultSessionId: 'current-session', defaultSessionMachineId: 'machine-1' },
    }) as z.ZodType;

    expect(search.safeParse({
      query: { v: 1, query: 'handoff', scope: { type: 'global' }, mode: 'hints' },
    }).success).toBe(true);
    expect(window.safeParse({ seqFrom: 1, seqTo: 2 }).success).toBe(false);
    expect(window.safeParse({ sessionId: 'historical-session', seqFrom: 1, seqTo: 2 }).success).toBe(true);
  });

  it('projects the same contextual schema for a trusted plugin Action tool', () => {
    const pluginToolCatalog: readonly ProjectedPluginToolCatalogEntry[] = [{
      toolId: 'acme.memory/search-tool',
      actionId: 'acme.memory/search',
      name: 'acme_memory_search',
      title: 'Search Acme memory',
      description: 'Search memory.',
      inputSchema: {
        type: 'object',
        properties: { machineId: { type: 'string' }, query: { type: 'string' } },
        required: ['machineId', 'query'],
        additionalProperties: false,
      },
      contextualDefaults: { machineId: 'current_session_machine' },
      surfaces: ['agent'],
    }];

    expect(projectSessionBoundActionToolInputSchema({
      actionId: 'acme.memory/search',
      inputSchema: pluginToolCatalog[0]!.inputSchema,
      context: { defaultSessionMachineId: 'machine-1' },
      pluginToolCatalog,
    })).toMatchObject({ required: ['query'] });
  });
});
