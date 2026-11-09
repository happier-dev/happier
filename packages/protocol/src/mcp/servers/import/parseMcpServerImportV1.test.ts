import { describe, expect, it } from 'vitest';
import { encodeMcpServerInstallLinkV1, parseMcpServerImportV1 } from './parseMcpServerImportV1.js';
import { decodeBase64, encodeBase64 } from '../../../crypto/base64.js';
import { McpServerCatalogEntryV1Schema } from '../settingsV1.js';

describe('parseMcpServerImportV1', () => {
    it.each(['stdio', 'http', 'sse'] as const)('round trips a names-only %s install link without credentials or value references', transport => {
        const server = McpServerCatalogEntryV1Schema.parse({ id: 'one', name: 'one', title: '日本語 tools', transport,
            ...(transport === 'stdio' ? { stdio: { command: 'tool', args: ['日本語'], cwd: { t: 'path', path: '/private/folder' } } }
                : { remote: { url: 'https://mcp.example.test/events', headers: {
                    Authorization: { t: 'template', template: 'Bearer {token}', vars: { token: { t: 'literal', v: 'private-header-token' } } },
                    'X-Tenant': { t: 'literal', v: 'private-tenant' },
                }, ...(transport === 'http' ? { auth: { kind: 'oauth' } } : {}) } }),
            env: { API_KEY: { t: 'savedSecret', secretId: 'private-secret-ref' }, MODE: { t: 'literal', v: 'private-env-value' } },
            configOverrides: [{ target: { t: 'machine', machineId: 'private-machine' }, envPatch: { TOKEN: { t: 'literal', v: 'private-override' } } }],
            createdAt: 1, updatedAt: 1 });
        const link = encodeMcpServerInstallLinkV1(server, 'https://web.example.test/?token=private-web-token#private-fragment');
        const url = new URL(link);
        expect(`${url.origin}${url.pathname}`).toBe('https://web.example.test/settings/mcp');
        const payload = new TextDecoder().decode(decodeBase64(url.searchParams.get('install')!, 'base64url'));
        expect(`${link}\n${payload}`).not.toContain('private-');
        expect(JSON.parse(payload)).toEqual({ name: server.name, title: server.title, transport,
            ...(server.stdio ? { command: 'tool', args: ['日本語'] } : { url: 'https://mcp.example.test/events' }),
            ...(transport === 'http' ? { auth: { kind: 'oauth' } } : {}),
            headerNames: transport === 'stdio' ? [] : ['Authorization', 'X-Tenant'], envNames: ['API_KEY', 'MODE'] });
        const parsed = parseMcpServerImportV1(link);
        expect(parsed.errors).toEqual([]);
        expect(parsed.warnings).toEqual([]);
        expect(parsed.servers).toMatchObject([{ name: 'one', title: server.title, transport,
            ...(server.stdio ? { stdio: { command: 'tool', args: ['日本語'] } }
                : { remote: { url: server.remote!.url, ...(transport === 'http' ? { auth: { kind: 'oauth' } } : {}) } }) }]);
        expect(parsed.inputs.map(input => input.title).sort()).toEqual(transport === 'stdio'
            ? ['API_KEY', 'MODE'] : ['API_KEY', 'Authorization', 'MODE', 'X-Tenant']);
        expect(parsed.inputs.every(input => input.suggestedValue === undefined)).toBe(true);
    });

    it.each([null, 'oauth', {}, { kind: 'bearer' }, { kind: 'oauth', token: 'private-token' },
        { kind: 'oauth', issuer: 'https://issuer.example.test' }, { kind: 'oauth', clientId: 'private-client' },
        { kind: 'oauth', signedIn: true }])('refuses malformed or credential-bearing auth intent %#', auth => {
        const parsed = parseMcpServerImportV1(JSON.stringify({ name: 'one', transport: 'http', url: 'https://mcp.example.test/mcp', auth }));
        expect(parsed.servers).toEqual([]);
        expect(parsed.errors).toEqual(['one: invalid-server-configuration']);
    });

    it.each([
        { transport: 'stdio', command: 'tool' },
        { transport: 'stdio', url: 'https://mcp.example.test/mcp' },
        { transport: 'sse', url: 'https://mcp.example.test/events' },
    ])('refuses OAuth intent on an unsupported transport %#', configuration => {
        const parsed = parseMcpServerImportV1(JSON.stringify({ name: 'one', ...configuration, auth: { kind: 'oauth' } }));
        expect(parsed.servers).toEqual([]);
        expect(parsed.errors).toEqual(['one: invalid-server-configuration']);
    });

    it('refuses exporting OAuth intent on SSE instead of silently dropping it', () => {
        const server = McpServerCatalogEntryV1Schema.parse({ id: 'one', name: 'one', transport: 'sse',
            remote: { url: 'https://mcp.example.test/events', headers: {}, auth: { kind: 'oauth' } },
            env: {}, createdAt: 0, updatedAt: 0 });
        expect(() => encodeMcpServerInstallLinkV1(server, 'https://web.example.test')).toThrow();
    });

    it('refuses exporting credential-bearing OAuth state', () => {
        const server = McpServerCatalogEntryV1Schema.parse({ id: 'one', name: 'one', transport: 'http',
            remote: { url: 'https://mcp.example.test/mcp', headers: {} }, env: {}, createdAt: 0, updatedAt: 0 });
        const withCredentials = { ...server, remote: { ...server.remote!, auth: { kind: 'oauth' as const, token: 'private-token' } } };
        expect(() => encodeMcpServerInstallLinkV1(withCredentials, 'https://web.example.test')).toThrow();
    });

    it.each([
        [{ mcpServers: { one: { command: 'tool', args: ['start'] } } }, 'stdio'],
        [{ servers: { one: { command: 'tool', args: ['start'] } } }, 'stdio'],
        [{ mcp: { one: { type: 'local', command: ['tool', 'start'], environment: { MODE: 'read' } } } }, 'stdio'],
        [{ context_servers: { one: { command: { path: 'tool', args: ['start'], env: { MODE: 'read' } } } } }, 'stdio'],
        [{ mcpServers: { one: { serverUrl: 'https://mcp.example.test' } } }, 'http'],
        [{ mcpServers: { one: { url: 'https://mcp.example.test/sse' } } }, 'http'],
        [{ mcpServers: { one: { httpUrl: 'https://mcp.example.test' } } }, 'http'],
        [{ name: 'one', command: 'tool', args: ['start'] }, 'stdio'],
    ])('reads the supported JSON shape %#', (config, transport) => {
        const parsed = parseMcpServerImportV1(JSON.stringify(config));
        expect(parsed.errors).toEqual([]);
        expect(parsed.servers).toHaveLength(1);
        expect(parsed.servers[0]?.transport).toBe(transport);
    });

    it('preserves the predecessor bare-URL import golden even when the address ends in /sse', () => {
        // Captured by executing ../0.2/apps/ui/sources/sync/domains/settings/mcpServers/parseImportedMcpServerJson.ts
        // at HEAD cd2bb4d853a259ae00ebc3e5981224e3e4bb5380; both parser and naming dependency were clean.
        const text = '{"mcpServers":{"one":{"url":"https://mcp.example.test/sse"}}}';
        expect(parseMcpServerImportV1(text)).toEqual({ servers: [{ name: 'one', transport: 'http',
            remote: { url: 'https://mcp.example.test/sse', headers: {} }, env: {}, enabled: true, warnings: [] }],
            inputs: [], warnings: [], errors: [] });
    });

    it.each(['type', 'transport'])('honors an explicit %s SSE marker', marker => {
        const parsed = parseMcpServerImportV1(JSON.stringify({ mcpServers: {
            one: { url: 'https://mcp.example.test/mcp', [marker]: 'sse' },
        } }));
        expect(parsed.errors).toEqual([]);
        expect(parsed.servers[0]).toMatchObject({ transport: 'sse', remote: { url: 'https://mcp.example.test/mcp' } });
    });

    it('lets an explicit choice override the httpUrl prefill', () => {
        expect(parseMcpServerImportV1(JSON.stringify({ mcpServers: {
            one: { httpUrl: 'https://mcp.example.test/stream', transport: 'sse' },
        } })).servers[0]?.transport).toBe('sse');
    });

    it('lets the canonical transport choice override a vendor type SSE prefill', () => {
        expect(parseMcpServerImportV1(JSON.stringify({ mcpServers: {
            one: { url: 'https://mcp.example.test/events', type: 'sse', transport: 'http' },
        } })).servers[0]?.transport).toBe('http');
    });

    it('uses Gemini sibling httpUrl evidence while preserving explicit HTTP choices', () => {
        const parsed = parseMcpServerImportV1(JSON.stringify({ mcpServers: {
            events: { url: 'https://mcp.example.test/events' },
            stream: { httpUrl: 'https://mcp.example.test/stream' },
            explicit: { url: 'https://mcp.example.test/explicit', transport: 'http' },
        } }));
        expect(parsed.errors).toEqual([]);
        expect(parsed.servers.map(server => [server.name, server.transport, server.remote?.url])).toEqual([
            ['events', 'sse', 'https://mcp.example.test/events'],
            ['stream', 'http', 'https://mcp.example.test/stream'],
            ['explicit', 'http', 'https://mcp.example.test/explicit'],
        ]);
    });

    it('asks explicitly for every named env and header value, including an apparent machine placeholder', () => {
        const parsed = parseMcpServerImportV1(JSON.stringify({ servers: { one: {
            url: 'https://mcp.example.test', env: { API_KEY: '${API_KEY}', MODE: 'read' },
            headers: { Authorization: 'Bearer literal-token' },
        } } }));
        expect(parsed.inputs).toHaveLength(3);
        expect(parsed.servers[0]?.env.API_KEY?.t).toBe('input');
        expect(parsed.inputs.some(input => input.secret && input.title === 'Authorization')).toBe(true);
    });

    it('does not silently filter invalid argument values', () => {
        const parsed = parseMcpServerImportV1(JSON.stringify({ servers: { one: { command: 'tool', args: [1] } } }));
        expect(parsed.errors.length).toBeGreaterThan(0);
        expect(parsed.servers).toEqual([]);
    });

    it.each([
        `cursor://anysphere.cursor-deeplink/mcp/install?name=one&config=${encodeBase64(new TextEncoder().encode(JSON.stringify({ command: 'tool', args: ['日本語'] })))}`,
        `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: 'one', command: 'tool', args: ['日本語'] }))}`,
        'goose://extension?cmd=tool&arg=%E6%97%A5%E6%9C%AC%E8%AA%9E&id=one&name=One',
        `https://app.happier.dev/settings/mcp?install=${encodeBase64(new TextEncoder().encode(JSON.stringify({ name: 'one', transport: 'stdio', command: 'tool', args: ['日本語'], envNames: ['API_KEY'] })), 'base64url')}`,
    ])('reads install-link data without fetching %s', raw => {
        const parsed = parseMcpServerImportV1(raw);
        expect(parsed.errors).toEqual([]);
        expect(parsed.servers[0]).toMatchObject({ name: 'one', stdio: { command: 'tool', args: ['日本語'] } });
    });

    it('keeps shared VS Code inputs in a header template and working folders', () => {
        const parsed = parseMcpServerImportV1(JSON.stringify({ servers: {
            one: { url: 'https://mcp.example.test', headers: { Authorization: 'Bearer ${input:token}' } },
            two: { command: 'tool', cwd: 'C:\\repo', env: { API_KEY: '${input:token}' } },
        }, inputs: [{ id: 'token', type: 'promptString', password: true, description: 'Token' }] }));
        expect(parsed.inputs).toEqual([{ inputId: 'token', title: 'token', secret: true, description: 'Token', suggestedEnvVarName: 'API_KEY' }]);
        expect(parsed.servers[0]?.remote?.headers.Authorization).toEqual({ t: 'template', template: 'Bearer {token}', vars: { token: { t: 'input', inputId: 'token' } } });
        expect(parsed.servers[1]?.stdio?.cwd).toEqual({ t: 'path', path: 'C:\\repo' });
    });

    it('reads a server.json through the registry selection owner, keeping named env inputs explicit', () => {
        const parsed = parseMcpServerImportV1(JSON.stringify({ name: 'dev.example/one', description: 'One', version: '1.2.3',
            packages: [{ registryType: 'npm', identifier: '@example/one', version: '1.2.3', transport: { type: 'stdio' },
                environmentVariables: [{ name: 'API_KEY', isRequired: true, isSecret: true }] }],
        }));
        expect(parsed.errors).toEqual([]);
        expect(parsed.servers[0]).toMatchObject({ name: 'dev.example/one', stdio: { command: 'npx', args: ['-y', '@example/one@1.2.3'] },
            env: { API_KEY: { t: 'input', inputId: 'dev.example/one:env:API_KEY' } } });
    });

    it('refuses unsupported server.json auth instead of the registry decoder dropping it', () => {
        const parsed = parseMcpServerImportV1(JSON.stringify({ name: 'dev.example/one', description: 'One', version: '1.2.3',
            packages: [{ registryType: 'npm', identifier: '@example/one', version: '1.2.3', transport: { type: 'stdio' } }],
            auth: { kind: 'oauth', token: 'private-token' },
        }));
        expect(parsed.servers).toEqual([]);
        expect(parsed.errors).toEqual(['invalid-server-json']);
    });
});
