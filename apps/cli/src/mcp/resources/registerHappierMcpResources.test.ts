import { describe, expect, it } from 'vitest';

import {
  HAPPIER_MCP_ACTION_SPECS_RESOURCE_URI,
  registerHappierMcpResources,
} from './registerHappierMcpResources';

describe('registerHappierMcpResources', () => {
  it('registers the action-specs resource and filters disabled actions', async () => {
    const resources: Array<{
      name: string;
      uri: string;
      config: { title: string; description: string; mimeType: string };
      handler: () => Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }>;
    }> = [];

    registerHappierMcpResources(
      {
        registerResource: (name, uri, config, handler) => {
          resources.push({ name, uri, config, handler });
        },
      },
      {
        surface: 'session_agent',
        isActionEnabled: (id) => id !== 'review.start',
      },
    );

    expect(resources).toHaveLength(1);
    expect(resources[0]?.name).toBe('happier_action_specs');
    expect(resources[0]?.uri).toBe(HAPPIER_MCP_ACTION_SPECS_RESOURCE_URI);
    expect(resources[0]?.config.mimeType).toBe('application/json');

    const read = await resources[0]!.handler();
    expect(read.contents).toHaveLength(1);
    expect(read.contents[0]?.uri).toBe(HAPPIER_MCP_ACTION_SPECS_RESOURCE_URI);

    const parsed = JSON.parse(read.contents[0]!.text);
    expect(parsed.actionSpecs.some((spec: { id: string }) => spec.id === 'review.start')).toBe(false);
    expect(parsed.actionSpecs.some((spec: { id: string }) => spec.id === 'subagents.plan.start')).toBe(true);
  });

  it('filters the action-specs catalog by surface', async () => {
    const readCatalog = async (surface: 'session_agent' | 'mcp') => {
      const resources: Array<{
        handler: () => Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }>;
      }> = [];

      registerHappierMcpResources(
        {
          registerResource: (_name, _uri, _config, nextHandler) => {
            resources.push({ handler: nextHandler });
          },
        },
        { surface, isActionEnabled: () => true },
      );

      expect(resources).toHaveLength(1);
      const res = await resources[0]!.handler();
      const parsed = JSON.parse(res.contents[0]!.text) as { actionSpecs?: Array<{ id?: string }> };
      return Array.isArray(parsed.actionSpecs) ? parsed.actionSpecs.map((spec) => String(spec.id ?? '')).filter(Boolean) : [];
    };

    const sessionAgentIds = await readCatalog('session_agent');
    const mcpIds = await readCatalog('mcp');

    expect(sessionAgentIds).not.toContain('session.target.primary.set');
    expect(mcpIds).toContain('session.target.primary.set');
  });
});
