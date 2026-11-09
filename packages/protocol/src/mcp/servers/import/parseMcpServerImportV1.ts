import { decodeBase64, encodeBase64 } from '../../../crypto/base64.js';
import { McpServerCatalogEntryV1Schema, type McpServerCatalogEntryTransportV1, type McpServerCatalogEntryV1 } from '../settingsV1.js';
import { readMcpRegistryServerV1 } from '../../../registries/formats/mcpRegistry.js';
import { mapMcpRegistryServerV1, selectMcpRegistryServerTransportV1 } from '../registry/mapMcpRegistryServerV1.js';
import { resolveValueRefPlaintextV1, type ValueRefV1 } from '../../../valueRefs/valueRefV1.js';

export type ImportedMcpDraftValueV1 =
    | Readonly<{ t: 'literal'; v: string }>
    | Readonly<{ t: 'input'; inputId: string }>
    | Readonly<{ t: 'template'; template: string; vars: Readonly<Record<string, Readonly<{ t: 'input'; inputId: string }>>> }>;
export type ImportedMcpInputDefinitionV1 = Readonly<{
    inputId: string; title: string; description?: string; secret: boolean; suggestedEnvVarName: string;
    suggestedValue?: string;
}>;
export type ImportedMcpServerDraftV1 = Readonly<{
    name: string; title?: string; description?: string; transport: McpServerCatalogEntryTransportV1;
    stdio?: { command: string; args: string[]; cwd?: NonNullable<McpServerCatalogEntryV1['stdio']>['cwd'] };
    remote?: { url: string; headers: Record<string, ImportedMcpDraftValueV1>; urlTemplate?: Extract<ImportedMcpDraftValueV1, { t: 'template' }>;
        auth?: NonNullable<McpServerCatalogEntryV1['remote']>['auth'] };
    env: Record<string, ImportedMcpDraftValueV1>; enabled: boolean; warnings: string[];
    origin?: McpServerCatalogEntryV1['origin'];
}>;
export type ParseMcpServerImportV1Result = Readonly<{
    servers: ImportedMcpServerDraftV1[]; inputs: ImportedMcpInputDefinitionV1[]; warnings: string[]; errors: string[];
}>;
type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const envToken = (value: string) => value.toUpperCase().replace(/[^A-Z0-9_]/gu, '_').replace(/^[0-9]/u, '_$&') || 'VALUE';
export const mcpImportValueInputIdV1 = (serverName: string, target: 'env' | 'header' | 'url-variable', key: string) => `${serverName}:${target}:${key}`;
export const isMcpImportSecretNameV1 = (name: string) => /TOKEN|SECRET|KEY|PASSWORD|PASSWD|AUTHORIZATION|AUTHENTICATION|CREDENTIAL/iu.test(name);

function decodeConfig(value: string): unknown {
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/u.test(value)) throw new Error('invalid-install-link');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64(value, 'base64url')));
}

/** Share configuration and required value names; never serialize value refs or sign-in state. */
export function encodeMcpServerInstallLinkV1(server: McpServerCatalogEntryV1, webappUrl: string): string {
    const auth = McpServerCatalogEntryV1Schema.shape.remote._zod.def.innerType.shape.auth.parse(server.remote?.auth);
    if (auth && server.transport !== 'http') throw new Error('invalid-install-auth');
    const payload = { name: server.name, ...(server.title ? { title: server.title } : {}), transport: server.transport,
        ...(server.transport === 'stdio' ? { command: server.stdio!.command, args: server.stdio!.args } : { url: server.remote!.url }),
        ...(auth ? { auth } : {}),
        headerNames: Object.keys(server.remote?.headers ?? {}), envNames: Object.keys(server.env) };
    const url = new URL('/settings/mcp', webappUrl);
    url.searchParams.set('install', encodeBase64(new TextEncoder().encode(JSON.stringify(payload)), 'base64url'));
    return url.toString();
}

/** Install URLs are data only. Parsing never fetches a URL or starts third-party code. */
function readInput(raw: string): unknown {
    if (/^\s*[{[]/u.test(raw)) return JSON.parse(raw);
    const url = new URL(raw, 'https://happier.invalid');
    if (url.protocol === 'cursor:' && url.hostname === 'anysphere.cursor-deeplink' && url.pathname === '/mcp/install') {
        const config = decodeConfig(url.searchParams.get('config') ?? '');
        return { mcpServers: { [url.searchParams.get('name') || 'server']: config } };
    }
    if ((url.protocol === 'vscode:' || url.protocol === 'vscode-insiders:') && url.pathname === 'mcp/install') {
        return JSON.parse(decodeURIComponent(url.search.slice(1)));
    }
    if (url.protocol === 'goose:' && url.hostname === 'extension') {
        const name = url.searchParams.get('id') || url.searchParams.get('name') || 'server';
        return { servers: { [name]: {
            title: url.searchParams.get('name') || undefined,
            description: url.searchParams.get('description') || undefined,
            ...(url.searchParams.has('url') ? { url: url.searchParams.get('url'), type: 'http' }
                : { command: url.searchParams.get('cmd'), args: url.searchParams.getAll('arg') }),
        } } };
    }
    if ((url.protocol === 'https:' || url.protocol === 'http:') && url.searchParams.has('install')) return decodeConfig(url.searchParams.get('install')!);
    throw new Error('invalid-install-link');
}

function container(raw: JsonObject): { servers: JsonObject; inputs?: unknown } | null {
    if (isObject(raw.mcpServers)) return { servers: raw.mcpServers, inputs: raw.inputs };
    if (isObject(raw.servers)) return { servers: raw.servers, inputs: raw.inputs };
    if (isObject(raw.context_servers)) return { servers: raw.context_servers, inputs: raw.inputs };
    if (isObject(raw.mcp)) {
        if (isObject(raw.mcp.servers)) return { servers: raw.mcp.servers, inputs: raw.mcp.inputs };
        return { servers: raw.mcp, inputs: raw.inputs };
    }
    if (raw.command !== undefined || raw.url !== undefined || raw.httpUrl !== undefined || raw.serverUrl !== undefined) {
        return { servers: { [nonempty(raw.name) ? raw.name : 'server']: raw }, inputs: raw.inputs };
    }
    for (const nested of Object.values(raw)) {
        if (!isObject(nested)) continue;
        const found = container(nested);
        if (found) return found;
    }
    return null;
}

function inputDefinitions(raw: unknown): Map<string, ImportedMcpInputDefinitionV1> {
    const entries = Array.isArray(raw) ? raw.filter(isObject).map(value => [value.id, value] as const)
        : isObject(raw) ? Object.entries(raw) : [];
    return new Map(entries.flatMap(([id, value]) => {
        if (!nonempty(id) || !isObject(value)) return [];
        return [[id, { inputId: id, title: nonempty(value.title) ? value.title : id,
            ...(nonempty(value.description) ? { description: value.description } : {}),
            secret: value.password === true || (nonempty(value.type) && isMcpImportSecretNameV1(value.type)),
            suggestedEnvVarName: envToken(id) }]];
    }));
}

function parseValueMap(serverName: string, target: 'env' | 'header', raw: unknown,
    inputs: Map<string, ImportedMcpInputDefinitionV1>): Record<string, ImportedMcpDraftValueV1> {
    if (raw === undefined) return {};
    if (!isObject(raw)) throw new Error('invalid-value-map');
    return Object.fromEntries(Object.entries(raw).map(([key, value]) => {
        if (!nonempty(key) || typeof value !== 'string') throw new Error('invalid-value');
        const matches = [...value.matchAll(/\$\{input:([^{}]+)\}/gu)];
        if (matches.length) {
            for (const match of matches) {
                const id = match[1]!;
                const defined = inputs.get(id);
                inputs.set(id, { ...(defined ?? { inputId: id, title: id }),
                    secret: defined?.secret === true || isMcpImportSecretNameV1(key),
                    suggestedEnvVarName: envToken(key) });
            }
            if (matches.length === 1 && matches[0]![0] === value) return [key, { t: 'input', inputId: matches[0]![1]! }];
            return [key, { t: 'template', template: value.replace(/\$\{input:([^{}]+)\}/gu, '{$1}'),
                vars: Object.fromEntries(matches.map(match => [match[1]!, { t: 'input', inputId: match[1]! }])) }];
        }
        const inputId = mcpImportValueInputIdV1(serverName, target, key);
        inputs.set(inputId, { inputId, title: key, secret: isMcpImportSecretNameV1(key),
            suggestedEnvVarName: envToken(key), suggestedValue: value });
        return [key, { t: 'input', inputId }];
    }));
}

function parseServer(name: string, raw: unknown, inputs: Map<string, ImportedMcpInputDefinitionV1>, urlTransport?: 'http' | 'sse'): ImportedMcpServerDraftV1 {
    if (!isObject(raw)) throw new Error('invalid-server');
    const auth = McpServerCatalogEntryV1Schema.shape.remote._zod.def.innerType.shape.auth.parse(raw.auth);
    if (auth && (raw.transport === 'stdio' || raw.transport === undefined && (raw.type === 'stdio' || raw.type === 'local'))) throw new Error('invalid-import-auth');
    const commandObject = isObject(raw.command) ? raw.command : null;
    const command = commandObject?.path ?? raw.command;
    const commandArray = isStrings(command) ? command : null;
    const executable = commandArray ? commandArray[0] : command;
    const args = commandArray ? commandArray.slice(1) : commandObject?.args ?? raw.args ?? [];
    const env = parseValueMap(name, 'env', commandObject?.env ?? raw.environment ?? raw.env, inputs);
    // Install-link exports intentionally carry names only.
    if (raw.envNames !== undefined) {
        if (!isStrings(raw.envNames)) throw new Error('invalid-env-names');
        for (const key of raw.envNames) {
            const inputId = mcpImportValueInputIdV1(name, 'env', key);
            inputs.set(inputId, { inputId, title: key, secret: isMcpImportSecretNameV1(key), suggestedEnvVarName: envToken(key) });
            env[key] = { t: 'input', inputId };
        }
    }
    const base = { name, ...(nonempty(raw.title) ? { title: raw.title } : {}),
        ...(nonempty(raw.description) ? { description: raw.description } : {}), env,
        enabled: raw.enabled !== false, warnings: Object.keys(raw).filter(key => ![
            'name', 'title', 'description', 'command', 'args', 'cwd', 'env', 'environment', 'envNames', 'headers', 'headerNames',
            'url', 'serverUrl', 'httpUrl', 'type', 'transport', 'enabled', 'inputs', 'auth',
        ].includes(key)).sort().map(key => `${name}: unsupported field "${key}"`) };
    if (nonempty(executable)) {
        if (auth) throw new Error('invalid-import-auth');
        if (!isStrings(args)) throw new Error('invalid-args');
        const cwd = raw.cwd ?? commandObject?.cwd;
        if (cwd !== undefined && !nonempty(cwd)) throw new Error('invalid-cwd');
        return { ...base, transport: 'stdio', stdio: { command: executable, args, ...(nonempty(cwd) ? { cwd: { t: 'path', path: cwd } as const } : {}) } };
    }
    const url = raw.httpUrl ?? raw.serverUrl ?? raw.url;
    if (!nonempty(url)) throw new Error('missing-command-or-url');
    const explicitTransport = raw.transport === 'http' || raw.transport === 'sse' ? raw.transport
        : raw.type === 'sse' ? 'sse' : raw.type === 'http' || raw.type === 'remote' ? 'http' : undefined;
    const transport = explicitTransport ?? (raw.httpUrl !== undefined || raw.serverUrl !== undefined ? 'http' : urlTransport ?? 'http');
    if (auth && transport !== 'http') throw new Error('invalid-import-auth');
    const headers = parseValueMap(name, 'header', raw.headers, inputs);
    if (raw.headerNames !== undefined) {
        if (!isStrings(raw.headerNames)) throw new Error('invalid-header-names');
        for (const key of raw.headerNames) {
            const inputId = mcpImportValueInputIdV1(name, 'header', key);
            inputs.set(inputId, { inputId, title: key, secret: isMcpImportSecretNameV1(key), suggestedEnvVarName: envToken(key) });
            headers[key] = { t: 'input', inputId };
        }
    }
    return { ...base, transport, remote: { url, headers, ...(auth ? { auth } : {}) } };
}

export function parseMcpServerImportV1(raw: string): ParseMcpServerImportV1Result {
    if (!raw.trim()) return { servers: [], inputs: [], warnings: [], errors: [] };
    let parsed: unknown;
    try { parsed = readInput(raw.trim()); }
    catch { return { servers: [], inputs: [], warnings: [], errors: ['invalid-json-or-install-link'] }; }
    if (!isObject(parsed)) return { servers: [], inputs: [], warnings: [], errors: ['object-required'] };
    if (Array.isArray(parsed.packages) || Array.isArray(parsed.remotes)) {
        try { return parseRegistryServer(parsed); }
        catch { return { servers: [], inputs: [], warnings: [], errors: ['invalid-server-json'] }; }
    }
    const found = container(parsed);
    if (!found) return { servers: [], inputs: [], warnings: [], errors: ['no-mcp-servers'] };
    // Gemini identifies its HTTP field explicitly. Without that sibling
    // evidence, a bare URL preserves the predecessor's HTTP default (IR-102).
    const urlTransport = Object.values(found.servers).some(value => isObject(value) && nonempty(value.httpUrl)) ? 'sse' : 'http';
    const inputs = inputDefinitions(found.inputs);
    const servers: ImportedMcpServerDraftV1[] = [];
    const errors: string[] = [];
    for (const [name, value] of Object.entries(found.servers)) {
        try { servers.push(parseServer(name, value, inputs, urlTransport)); }
        catch { errors.push(`${name}: invalid-server-configuration`); }
    }
    const referenced = new Set(servers.flatMap(server => [...Object.values(server.env), ...Object.values(server.remote?.headers ?? {})].flatMap(value =>
        value.t === 'input' ? [value.inputId] : value.t === 'template' ? Object.values(value.vars).map(variable => variable.inputId) : [])));
    return { servers, inputs: [...inputs.values()].filter(input => referenced.has(input.inputId)),
        warnings: [...new Set(servers.flatMap(server => server.warnings))], errors };
}

/** Registry transport/package/argument decisions remain in the shared mapper. */
function parseRegistryServer(raw: unknown): ParseMcpServerImportV1Result {
    // Registry server.json does not declare this install-payload extension.
    if (isObject(raw) && Object.hasOwn(raw, 'auth')) throw new Error('invalid-registry-auth');
    const server = readMcpRegistryServerV1(raw);
    const selected = selectMcpRegistryServerTransportV1(server);
    const supplied: Record<string, ValueRefV1> = {};
    for (const input of selected.inputs) supplied[input.name] = { t: 'literal', v: input.value ?? input.default ?? input.choices?.[0]
        ?? `\${input:${mcpImportValueInputIdV1(server.name, input.target, input.name)}}` };
    const mapped = mapMcpRegistryServerV1({ server, id: 'import-preview', name: 'import_preview', nowMs: 0, inputs: supplied });
    if (!mapped.ok) throw new Error('unresolved-server-json-arguments');
    const entry = mapped.entry;
    const render = (ref: ValueRefV1) => {
        const value = resolveValueRefPlaintextV1(ref, () => null);
        if (value === null) throw new Error('unresolved-server-json-value');
        return value;
    };
    const inputs = new Map<string, ImportedMcpInputDefinitionV1>();
    const draft = parseServer(server.name, { title: server.title, description: server.description,
        ...(entry.stdio ? { command: entry.stdio.command, args: entry.stdio.args } : { url: entry.remote!.url, transport: entry.transport,
            headers: Object.fromEntries(Object.entries(entry.remote!.headers).map(([key, ref]) => [key, render(ref)])) }),
        env: Object.fromEntries(Object.entries(entry.env).map(([key, ref]) => [key, render(ref)])),
    }, inputs);
    for (const input of selected.inputs) {
        const id = mcpImportValueInputIdV1(server.name, input.target, input.name);
        const defined = inputs.get(id);
        if (defined) inputs.set(id, { ...defined, title: input.name, secret: input.secret,
            ...(input.description ? { description: input.description } : {}) });
    }
    if (entry.remote?.urlTemplate) {
        const vars = Object.fromEntries(Object.keys(entry.remote.urlTemplate.vars).map(name => {
            const input = selected.inputs.find(input => input.target === 'url-variable' && input.name === name)!;
            const inputId = mcpImportValueInputIdV1(server.name, 'url-variable', name);
            inputs.set(inputId, { inputId, title: name, secret: input.secret, suggestedEnvVarName: envToken(name),
                ...(input.value ?? input.default ? { suggestedValue: input.value ?? input.default } : {}) });
            return [name, { t: 'input' as const, inputId }];
        }));
        return { servers: [{ ...draft, remote: { ...draft.remote!, urlTemplate: { t: 'template', template: entry.remote.urlTemplate.template, vars } } }],
            inputs: [...inputs.values()], warnings: draft.warnings, errors: [] };
    }
    return { servers: [draft], inputs: [...inputs.values()], warnings: draft.warnings, errors: [] };
}
