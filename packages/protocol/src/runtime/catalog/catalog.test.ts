import { describe, expect, it } from 'vitest';

import * as runtime from '../index.js';

type SchemaExport = Readonly<{
  safeParse?: (value: unknown) => unknown;
}>;

function readSchemaExport(name: string): SchemaExport | undefined {
  return (runtime as Record<string, unknown>)[name] as SchemaExport | undefined;
}

describe('runtime catalog protocol contracts', () => {
  it('exports vendor plugin and skill catalog schemas from the runtime package', () => {
    expect(typeof readSchemaExport('VendorPluginCatalogItemV1Schema')?.safeParse).toBe('function');
    expect(typeof readSchemaExport('VendorPluginCatalogV1Schema')?.safeParse).toBe('function');
    expect(typeof readSchemaExport('SkillCatalogItemV1Schema')?.safeParse).toBe('function');
    expect(typeof readSchemaExport('SkillCatalogV1Schema')?.safeParse).toBe('function');
  });

  it('parses canonical vendor plugin and skill catalog item metadata', () => {
    const vendorPluginItemSchema = readSchemaExport('VendorPluginCatalogItemV1Schema');
    const skillItemSchema = readSchemaExport('SkillCatalogItemV1Schema');

    expect(vendorPluginItemSchema?.safeParse?.({
      v: 1,
      backendId: 'codex',
      agentId: 'codex-agent',
      vendorPluginRef: 'plugin://gmail@openai-curated',
      displayName: 'Gmail',
      installed: true,
      enabled: true,
    })).toMatchObject({
      success: true,
      data: expect.objectContaining({
        backendId: 'codex',
        agentId: 'codex-agent',
        mentionable: true,
      }),
    });

    expect(skillItemSchema?.safeParse?.({
      v: 1,
      id: 'codex:review',
      origin: 'vendor',
      name: 'review',
      backendId: 'codex',
      agentId: 'codex-agent',
      projectionRef: 'codex-native:review',
    })).toMatchObject({
      success: true,
      data: expect.objectContaining({
        origin: 'vendor',
        backendId: 'codex',
        agentId: 'codex-agent',
        projectionRef: 'codex-native:review',
      }),
    });
  });
});
