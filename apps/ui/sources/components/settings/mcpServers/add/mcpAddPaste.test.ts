import { describe, expect, it } from 'vitest';

import { parseMcpServerImportV1 } from '@happier-dev/protocol/mcp/servers/import/parseMcpServerImportV1';
import { prepareMcpServerImportV1 } from '@happier-dev/protocol/mcp/servers/import/mcpServerImportV1';

import {
  buildMcpPasteValues,
  buildMcpPastePreviewModel,
  countOpenMcpPasteValues,
  EMPTY_MCP_PASTE_ANSWERS,
  withMcpPasteServerTransport,
} from './mcpAddPaste';

const preview = (text: string) =>
  prepareMcpServerImportV1({ parsed: parseMcpServerImportV1(text), catalog: { servers: [] } });

const config = JSON.stringify({
  mcpServers: {
    'brave-search': { command: 'npx', args: ['-y', '@brave/brave-search-mcp-server'], env: { BRAVE_API_KEY: 'BSAk3Lq9' } },
    postgres: { command: 'npx', args: ['@modelcontextprotocol/server-postgres'], env: { PGAPPNAME: '${USER}' } },
    sentry: { url: 'https://mcp.sentry.dev/mcp' },
  },
});

describe('paste a config → Add details', () => {
  it('keeps explicit OAuth intent in the preview without requiring credentials or adding it to public remotes', () => {
    const model = buildMcpPastePreviewModel(preview(JSON.stringify({ mcpServers: {
      authenticated: { transport: 'http', url: 'https://tools.example/mcp', auth: { kind: 'oauth' } },
      public: { transport: 'http', url: 'https://docs.example/mcp' },
    } })));
    expect(model.servers[0]).toMatchObject({ auth: { kind: 'oauth' } });
    expect(model.servers[1]).not.toHaveProperty('auth');
    expect(countOpenMcpPasteValues(model, EMPTY_MCP_PASTE_ANSWERS)).toBe(0);
    expect(buildMcpPasteValues(model, EMPTY_MCP_PASTE_ANSWERS)).toEqual({});
  });

  it('moves a pasted key into a Saved Secret named after its server and asks nothing else', () => {
    const model = buildMcpPastePreviewModel(preview(config));
    const brave = model.servers.find((server) => server.name === 'brave-search')!;
    expect(brave.literalSecrets).toEqual([{ inputId: 'brave-search:env:BRAVE_API_KEY', key: 'BRAVE_API_KEY', secretName: 'brave-search' }]);
    expect(brave.env).toEqual([]);
    const values = buildMcpPasteValues(model, EMPTY_MCP_PASTE_ANSWERS);
    expect(values['brave-search:env:BRAVE_API_KEY']).toMatchObject({ t: 'saveSecret', name: 'brave-search' });
    // The real importer accepts these values: nothing is left missing.
    const answered = prepareMcpServerImportV1({ parsed: parseMcpServerImportV1(config), catalog: { servers: [] }, values });
    expect(answered.missingValues.filter((input) => input.inputId.startsWith('brave-search'))).toEqual([]);
  });

  it('asks a value that was only named until it has an answer, and sends a Saved Secret for a secret field', () => {
    const text = JSON.stringify({
      servers: { github: { command: 'github-mcp', env: { GITHUB_TOKEN: '${input:github_token}' } } },
      inputs: [{ id: 'github_token', password: true }],
    });
    const model = buildMcpPastePreviewModel(preview(text));
    expect(model.servers[0]!.env).toEqual([]);
    expect(model.fields).toMatchObject([{ inputId: 'github_token', secret: true }]);
    expect(countOpenMcpPasteValues(model, EMPTY_MCP_PASTE_ANSWERS)).toBe(1);
    const answers = { rows: {}, fields: { github_token: ' ghp_value ' } };
    expect(countOpenMcpPasteValues(model, answers)).toBe(0);
    expect(buildMcpPasteValues(model, answers).github_token).toEqual({ t: 'createSecret', name: 'github_token', kind: 'apiKey', value: 'ghp_value' });
  });

  it('keeps a value type the person chose for a named env value', () => {
    const text = JSON.stringify({ mcpServers: { one: { command: 'tool', envNames: ['API_KEY'] } } });
    const model = buildMcpPastePreviewModel(preview(text));
    const ask = model.servers[0]!.env[0]!;
    expect(ask).toMatchObject({ inputId: 'one:env:API_KEY', key: 'API_KEY', secret: true });
    expect(countOpenMcpPasteValues(model, EMPTY_MCP_PASTE_ANSWERS)).toBe(1);
    const answers = { rows: { [ask.inputId]: { t: 'literal' as const, v: '${API_KEY}' } }, fields: {} };
    expect(countOpenMcpPasteValues(model, answers)).toBe(0);
    expect(buildMcpPasteValues(model, answers)[ask.inputId]).toEqual({ t: 'literal', v: '${API_KEY}' });
  });

  it('writes a changed remote transport into that server, and the real parser then reads it', () => {
    const next = withMcpPasteServerTransport(config, 'sentry', 'sse')!;
    expect(parseMcpServerImportV1(next).servers.find((server) => server.name === 'sentry')?.transport).toBe('sse');
    expect(parseMcpServerImportV1(parseBare('https://x.example/mcp')).servers[0]!.transport).toBe('http');
    const flipped = withMcpPasteServerTransport(parseBare('https://x.example/mcp'), 'server', 'sse')!;
    expect(parseMcpServerImportV1(flipped).servers[0]!.transport).toBe('sse');
    // Next to a Gemini `httpUrl`, a bare `url` reads as SSE; choosing HTTP writes it explicitly.
    const gemini = JSON.stringify({ mcpServers: { a: { httpUrl: 'https://a.example/mcp' }, b: { url: 'https://b.example/sse' } } });
    expect(parseMcpServerImportV1(gemini).servers.map((server) => server.transport)).toEqual(['http', 'sse']);
    expect(parseMcpServerImportV1(withMcpPasteServerTransport(gemini, 'b', 'http')!).servers.map((server) => server.transport)).toEqual(['http', 'http']);
    // An install link has no JSON to write into.
    expect(withMcpPasteServerTransport('https://app.example/settings/mcp?install=abc', 'sentry', 'sse')).toBeNull();
  });
});

function parseBare(url: string): string {
  return JSON.stringify({ url });
}
