import { describe, expect, it } from 'vitest';

import { BotTemplateMcpDefinitionV1Schema, projectBotTemplateMcpDefinitionV1 } from './portableMcpDefinitionV1.js';
import type { McpServerCatalogEntryV1 } from './settingsV1.js';

describe('portable MCP definitions', () => {
  it('replaces all source bindings and URL values with declared inputs while preserving URL query order', () => {
    const source: McpServerCatalogEntryV1 = {
      id: 'source-catalog-id', name: 'example', description: 'Example MCP', transport: 'http',
      remote: {
        url: 'https://synthetic-user:synthetic-password@mcp.example.test/api?token=synthetic-query&mode=synthetic-mode&token=synthetic-second',
        headers: { Authorization: { t: 'literal', v: 'synthetic-header' } }, auth: { kind: 'oauth' },
      },
      env: { API_KEY: { t: 'savedSecret', secretId: 'synthetic-source-secret-id' } },
      createdAt: 0, updatedAt: 0,
    };
    const projected = projectBotTemplateMcpDefinitionV1(source);
    const serialized = JSON.stringify(projected);
    for (const forbidden of ['source-catalog-id', 'synthetic-user', 'synthetic-password', 'synthetic-query', 'synthetic-mode', 'synthetic-second', 'synthetic-header', 'synthetic-source-secret-id']) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(BotTemplateMcpDefinitionV1Schema.parse(projected)).toEqual(projected);
    expect(projected.remote?.url).toMatchObject({ baseUrl: { kind: 'literal', value: 'https://mcp.example.test/api' }, query: [
      { key: { kind: 'literal', value: 'token' }, value: { kind: 'input' } },
      { key: { kind: 'literal', value: 'mode' }, value: { kind: 'input' } },
      { key: { kind: 'literal', value: 'token' }, value: { kind: 'input' } },
    ] });
    expect(projected.auth).toEqual({ kind: 'oauth' });
    expect(projected.inputs).toHaveLength(7);
    expect(projected.inputs.every(input => input.required && input.secret)).toBe(true);
    expect(projectBotTemplateMcpDefinitionV1(source)).toEqual(projected);
  });

  it('keeps commands and arguments inspectable and replaces source working folders without exporting overrides', () => {
    const source: McpServerCatalogEntryV1 = {
      id: 'source-id', name: 'example', transport: 'stdio',
      stdio: { command: 'example-mcp', args: ['--token=synthetic-argument', '--verbose'], cwd: { t: 'path', path: '/synthetic/source/path' } },
      env: { ENV: { t: 'literal', v: 'synthetic-env' } },
      configOverrides: [{ target: { t: 'machine', machineId: 'source-machine' }, envPatch: { OVERRIDE: { t: 'literal', v: 'synthetic-override' } } }],
      createdAt: 0, updatedAt: 0,
    };
    const projected = projectBotTemplateMcpDefinitionV1(source);
    expect(projected.stdio).toEqual({
      command: { kind: 'literal', value: 'example-mcp' },
      args: [{ kind: 'literal', value: '--token=synthetic-argument' }, { kind: 'literal', value: '--verbose' }],
      cwd: { kind: 'input', key: 'cwd' },
    });
    expect(projected.inputs).toContainEqual(expect.objectContaining({ key: 'cwd', secret: false, required: true }));
    for (const forbidden of ['source-id', '/synthetic/source/path', 'synthetic-env', 'source-machine', 'synthetic-override']) {
      expect(JSON.stringify(projected)).not.toContain(forbidden);
    }
    expect(BotTemplateMcpDefinitionV1Schema.parse(projected)).toEqual(projected);
    expect(projectBotTemplateMcpDefinitionV1({ ...source, stdio: { ...source.stdio!, cwd: { t: 'session' } } }).stdio?.cwd).toEqual({ kind: 'session' });
  });

  it('rejects executable unknown fields, unbound inputs, hidden URL values and wrong transport branches', () => {
    const valid = projectBotTemplateMcpDefinitionV1({
      id: 'source', name: 'example', transport: 'stdio', stdio: { command: 'example-mcp', args: [] }, env: {}, createdAt: 0, updatedAt: 0,
    });
    expect(BotTemplateMcpDefinitionV1Schema.safeParse({ ...valid, sourceId: 'source' }).success).toBe(false);
    expect(BotTemplateMcpDefinitionV1Schema.safeParse({ ...valid, stdio: { ...valid.stdio, command: { kind: 'input', key: 'missing' } } }).success).toBe(false);
    expect(BotTemplateMcpDefinitionV1Schema.safeParse({ ...valid, transport: 'sse' }).success).toBe(false);
    expect(BotTemplateMcpDefinitionV1Schema.safeParse({ ...valid, inputs: [{ key: 'input', label: 'Value', purpose: 'Header', secret: true, required: true, default: 'hidden' }] }).success).toBe(false);
    expect(BotTemplateMcpDefinitionV1Schema.safeParse({ ...valid, env: { TOKEN: { kind: 'literal', value: 'hidden' } } }).success).toBe(false);
    const remote = projectBotTemplateMcpDefinitionV1({ id: 'source', name: 'example', transport: 'http', remote: { url: 'https://example.test/', headers: {} }, env: {}, createdAt: 0, updatedAt: 0 });
    for (const baseUrl of ['invalid', 'https://example.test/?token=hidden']) {
      expect(BotTemplateMcpDefinitionV1Schema.safeParse({ ...remote, remote: { ...remote.remote, url: { baseUrl: { kind: 'literal', value: baseUrl }, query: [] } } }).success).toBe(false);
    }
  });

  it('preserves empty query keys and empty values as recipient inputs', () => {
    const projected = projectBotTemplateMcpDefinitionV1({
      id: 'source', name: 'example', transport: 'sse',
      remote: { url: 'https://mcp.example.test/?=synthetic&mode=', headers: {} },
      env: {}, createdAt: 0, updatedAt: 0,
    });
    expect(BotTemplateMcpDefinitionV1Schema.safeParse(projected).success).toBe(true);
    expect(projected.remote?.url.query.map(parameter => parameter.key)).toEqual([{ kind: 'literal', value: '' }, { kind: 'literal', value: 'mode' }]);
    expect(projected.inputs).toHaveLength(2);
    expect(JSON.stringify(projected)).not.toContain('synthetic');
  });

  it('preserves query requirements from the catalog URL template without carrying its bindings', () => {
    const projected = projectBotTemplateMcpDefinitionV1({
      id: 'source', name: 'example', transport: 'http', env: {}, createdAt: 0, updatedAt: 0,
      remote: {
        url: 'https://mcp.example.test/api', headers: {},
        urlTemplate: { t: 'template', template: 'https://mcp.example.test/api?token={token}&mode=synthetic-value', vars: { token: { t: 'savedSecret', secretId: 'synthetic-secret-id' } } },
      },
    });
    expect(projected.remote?.url.baseUrl).toEqual({ kind: 'literal', value: 'https://mcp.example.test/api' });
    expect(projected.remote?.url.query.map(parameter => parameter.key)).toEqual([{ kind: 'literal', value: 'token' }, { kind: 'literal', value: 'mode' }]);
    expect(BotTemplateMcpDefinitionV1Schema.safeParse(projected).success).toBe(true);
    expect(JSON.stringify(projected)).not.toContain('synthetic');
  });

  it('requests a recipient endpoint when template variables affect the host or path', () => {
    const projected = projectBotTemplateMcpDefinitionV1({
      id: 'source', name: 'example', transport: 'http', env: {}, createdAt: 0, updatedAt: 0,
      remote: { url: 'https://input.example.test/input', headers: {}, urlTemplate: {
        t: 'template', template: 'https://{region}.example.test/{tenant}?token={token}',
        vars: { region: { t: 'literal', v: 'synthetic-region' }, tenant: { t: 'literal', v: 'synthetic-tenant' }, token: { t: 'savedSecret', secretId: 'synthetic-token-id' } },
      } },
    });
    expect(projected.remote?.url.baseUrl).toEqual({ kind: 'input', key: 'url:base' });
    expect(projected.remote?.url.query.map(parameter => parameter.key)).toEqual([{ kind: 'literal', value: 'token' }]);
    expect(projected.inputs).toContainEqual(expect.objectContaining({ key: 'url:base', secret: true, required: true }));
    expect(BotTemplateMcpDefinitionV1Schema.safeParse(projected).success).toBe(true);
    expect(JSON.stringify(projected)).not.toContain('synthetic');
  });

  it('declares variable query keys without copying their source values', () => {
    const projected = projectBotTemplateMcpDefinitionV1({
      id: 'source', name: 'example', transport: 'http', env: {}, createdAt: 0, updatedAt: 0,
      remote: { url: 'https://mcp.example.test/api', headers: {}, urlTemplate: {
        t: 'template', template: 'https://mcp.example.test/api?{key}={value}&fixed=x&fixed=y',
        vars: { key: { t: 'literal', v: 'synthetic-key' }, value: { t: 'savedSecret', secretId: 'synthetic-value' } },
      } },
    });
    expect(projected.remote?.url.query[0]?.key).toEqual({ kind: 'input', key: 'url:query-key:0' });
    expect(projected.inputs).toContainEqual(expect.objectContaining({ key: 'url:query-key:0', secret: true, required: true }));
    expect(JSON.stringify(projected)).not.toContain('synthetic');
    expect(BotTemplateMcpDefinitionV1Schema.safeParse(projected).success).toBe(true);
  });
});
