import { describe, expect, it } from 'vitest';
import { createMcpCatalogPermissionChoiceV1 } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';
import { McpServerCatalogV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { resolveMcpToolIdentity } from './resolveMcpToolIdentity';
import { assignMcpWireNames } from './assignMcpWireNames';
describe('MCP session wire names', () => {
  it('preserves catalog names and deterministically suffixes collisions with plugin and native names', () => {
    const items = [
      { serverId: 'plugin:plugin/docs', name: 'docs', serverTitle: 'Plugin docs', plugin: { pluginId: 'plugin', localId: 'docs' } },
      { serverId: 'catalog', name: 'docs', serverTitle: 'Catalog docs' },
      { serverId: 'other', name: 'other', serverTitle: 'Other' },
    ];
    const result = assignMcpWireNames({ items, nativeServerNames: ['other'] });
    expect(result.wireNamesByServerId).toEqual({ catalog: 'docs', 'plugin:plugin/docs': 'docs_2', other: 'other_2' });
    expect(result.mcpServerIdentities.docs).toMatchObject({ serverId: 'catalog', serverTitle: 'Catalog docs' });
    expect(result.mcpServerIdentities.docs_2).toMatchObject({ serverId: 'plugin:plugin/docs', plugin: { pluginId: 'plugin', localId: 'docs' } });
    expect(assignMcpWireNames({ items: [...items].reverse(), nativeServerNames: ['other'] })).toEqual(result);
    expect(result.mcpServerIdentities).not.toHaveProperty('happier');
  });
});

it.each(['qa_muse_r1117c', 'qa-muse-r1117c'])('maps native approval for catalog %s back to its durable server id', name => {
  const mapping = assignMcpWireNames({ items: [{ serverId: 'qa-muse-r1117c-mcp', name, serverTitle: 'QA' }] });
  const catalog = McpServerCatalogV1Schema.parse({ v: 1, servers: [{
    id: 'qa-muse-r1117c-mcp', name, title: 'QA', transport: 'stdio',
    stdio: { command: 'fixture', args: [] }, env: {}, createdAt: 1, updatedAt: 1,
  }], bindings: [] });
  const mcpTool = resolveMcpToolIdentity({ toolName: 'mcp__qa_muse_r1117c__qa_echo', permissionMode: 'default',
    context: { ...mapping, catalog: { status: 'ready', authority: 'active', revision: 1, diagnostics: [], catalog } } });
  expect(createMcpCatalogPermissionChoiceV1({ mcpTool, existingChoices: [],
    grant: { id: 'once', label: 'Allow once', scope: 'once', decision: 'approved', response: { approved: true } },
  })?.followUp).toEqual({ actionId: 'mcp.servers.tools.set', input: {
    serverId: 'qa-muse-r1117c-mcp', tools: { qa_echo: 'allow' },
  } });
});

it('reserves normalized native names and assigns distinct keys to punctuation collisions', () => {
  const result = assignMcpWireNames({ nativeServerNames: ['qa-muse'], items: [
    { serverId: 'a', name: 'qa-muse', serverTitle: 'A' },
    { serverId: 'b', name: 'qa_muse', serverTitle: 'B' },
  ] });
  expect(result.wireNamesByServerId).toEqual({ a: 'qa_muse_2', b: 'qa_muse_3' });
  expect(result.mcpServerIdentities.qa_muse_2?.serverId).toBe('a');
  expect(result.mcpServerIdentities.qa_muse_3?.serverId).toBe('b');
});
