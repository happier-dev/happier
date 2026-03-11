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
});
