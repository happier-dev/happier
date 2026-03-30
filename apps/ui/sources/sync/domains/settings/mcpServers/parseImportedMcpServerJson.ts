import type { McpServerCatalogEntryTransportV1 } from '@happier-dev/protocol';

import { toEnvToken } from './mcpCatalogNaming';

export type ImportedMcpDraftValueV1 =
    | { t: 'literal'; v: string }
    | { t: 'input'; inputId: string };

export type ImportedMcpInputDefinitionV1 = Readonly<{
    inputId: string;
    title: string;
    description?: string;
    secret: boolean;
    suggestedEnvVarName: string;
}>;

export type ImportedMcpServerDraftV1 = Readonly<{
    name: string;
    title?: string;
    transport: McpServerCatalogEntryTransportV1;
    stdio?: { command: string; args: string[] };
    remote?: { url: string; headers: Record<string, ImportedMcpDraftValueV1> };
    env: Record<string, ImportedMcpDraftValueV1>;
    enabled: boolean;
    warnings: string[];
}>;

export type ParseImportedMcpServerJsonResult = Readonly<{
    servers: ImportedMcpServerDraftV1[];
    inputs: ImportedMcpInputDefinitionV1[];
    warnings: string[];
    errors: string[];
}>;

type PlainObject = Record<string, unknown>;

const INPUT_REF_PATTERN = /^\$\{input:([A-Za-z0-9._-]+)\}$/;

function isPlainObject(value: unknown): value is PlainObject {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeTransport(value: unknown): McpServerCatalogEntryTransportV1 | null {
    if (value === 'http' || value === 'sse' || value === 'stdio') return value;
    return null;
}

function detectUnsupportedServerFields(serverName: string, value: PlainObject): string[] {
    const supported = new Set(['command', 'args', 'url', 'transport', 'type', 'headers', 'env', 'enabled', 'title']);
    return Object.keys(value)
        .filter((key) => !supported.has(key))
        .sort()
        .map((key) => `${serverName}: unsupported field "${key}"`);
}

function parseDraftValue(value: unknown): ImportedMcpDraftValueV1 | null {
    if (typeof value !== 'string') return null;
    const inputMatch = value.match(INPUT_REF_PATTERN);
    if (inputMatch) {
        return { t: 'input', inputId: inputMatch[1]! };
    }
    return { t: 'literal', v: value };
}

function parseValueMap(value: unknown): Record<string, ImportedMcpDraftValueV1> {
    if (!isPlainObject(value)) return {};
    const out: Record<string, ImportedMcpDraftValueV1> = {};
    for (const [key, rawValue] of Object.entries(value)) {
        if (typeof key !== 'string' || key.trim().length === 0) continue;
        const parsed = parseDraftValue(rawValue);
        if (!parsed) continue;
        out[key] = parsed;
    }
    return out;
}

function collectSuggestedEnvNamesFromServer(
    draft: ImportedMcpServerDraftV1,
    suggestions: Map<string, string>,
) {
    for (const [envKey, value] of Object.entries(draft.env)) {
        if (value.t !== 'input') continue;
        if (!suggestions.has(value.inputId)) {
            suggestions.set(value.inputId, envKey);
        }
    }
    for (const [headerKey, value] of Object.entries(draft.remote?.headers ?? {})) {
        if (value.t !== 'input') continue;
        if (!suggestions.has(value.inputId)) {
            suggestions.set(value.inputId, headerKey);
        }
    }
}

function parseInputDefinitions(value: unknown, suggestions: Map<string, string>): ImportedMcpInputDefinitionV1[] {
    const entries: Array<{ id: string; value: unknown }> = Array.isArray(value)
        ? value
            .filter(isPlainObject)
            .map((item) => ({ id: typeof item.id === 'string' ? item.id : '', value: item }))
            .filter((item) => item.id.trim().length > 0)
        : isPlainObject(value)
            ? Object.entries(value).map(([id, item]) => ({ id, value: item }))
            : [];

    return entries.map(({ id, value }) => {
        const config = isPlainObject(value) ? value : {};
        const type = typeof config.type === 'string' ? config.type.toLowerCase() : '';
        const secret = config.password === true || type.includes('password') || type.includes('secret') || type.includes('token');
        return {
            inputId: id,
            title: typeof config.title === 'string' && config.title.trim() ? config.title.trim() : id,
            description: typeof config.description === 'string' && config.description.trim() ? config.description.trim() : undefined,
            secret,
            suggestedEnvVarName: toEnvToken(suggestions.get(id) ?? id),
        };
    });
}

function parseServerDraft(serverName: string, value: unknown): ImportedMcpServerDraftV1 | null {
    if (!isPlainObject(value)) return null;

    const warnings = detectUnsupportedServerFields(serverName, value);
    const enabled = value.enabled !== false;
    const env = parseValueMap(value.env);
    const title = typeof value.title === 'string' && value.title.trim().length > 0 ? value.title.trim() : undefined;

    if (typeof value.command === 'string' && value.command.trim()) {
        const args = Array.isArray(value.args) ? value.args.filter((arg): arg is string => typeof arg === 'string') : [];
        return {
            name: serverName,
            title,
            transport: 'stdio',
            stdio: {
                command: value.command,
                args,
            },
            env,
            enabled,
            warnings,
        };
    }

    if (typeof value.url === 'string' && value.url.trim()) {
        const transport = normalizeTransport(value.transport) ?? normalizeTransport(value.type) ?? 'http';
        return {
            name: serverName,
            title,
            transport: transport === 'stdio' ? 'http' : transport,
            remote: {
                url: value.url,
                headers: parseValueMap(value.headers),
            },
            env,
            enabled,
            warnings,
        };
    }

    return null;
}

function extractServerContainer(raw: PlainObject): { servers: PlainObject; inputs: unknown } | null {
    const candidates: Array<{ servers: unknown; inputs: unknown }> = [
        { servers: raw.mcpServers, inputs: raw.inputs },
        { servers: raw.servers, inputs: raw.inputs },
        { servers: isPlainObject(raw.mcp) ? raw.mcp.servers : undefined, inputs: isPlainObject(raw.mcp) ? raw.mcp.inputs : undefined },
    ];

    for (const candidate of candidates) {
        if (isPlainObject(candidate.servers)) {
            return { servers: candidate.servers, inputs: candidate.inputs };
        }
    }

    for (const nested of Object.values(raw)) {
        if (!isPlainObject(nested)) continue;
        const detected = extractServerContainer(nested);
        if (detected) return detected;
    }

    return null;
}

export function parseImportedMcpServerJson(raw: string): ParseImportedMcpServerJsonResult {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) {
        return { servers: [], inputs: [], warnings: [], errors: [] };
    }

    let parsedRaw: unknown;
    try {
        parsedRaw = JSON.parse(trimmed);
    } catch {
        return {
            servers: [],
            inputs: [],
            warnings: [],
            errors: ['Invalid JSON'],
        };
    }

    if (!isPlainObject(parsedRaw)) {
        return {
            servers: [],
            inputs: [],
            warnings: [],
            errors: ['JSON must describe an object'],
        };
    }

    const container = extractServerContainer(parsedRaw);
    if (!container) {
        return {
            servers: [],
            inputs: [],
            warnings: [],
            errors: ['No MCP servers were found'],
        };
    }

    const warnings: string[] = [];
    const servers = Object.entries(container.servers)
        .map(([serverName, value]) => {
            const parsed = parseServerDraft(serverName, value);
            if (!parsed) {
                warnings.push(`${serverName}: unsupported server configuration`);
                return null;
            }
            warnings.push(...parsed.warnings);
            return parsed;
        })
        .filter((value): value is ImportedMcpServerDraftV1 => Boolean(value));

    const suggestions = new Map<string, string>();
    for (const server of servers) {
        collectSuggestedEnvNamesFromServer(server, suggestions);
    }

    const inputs = parseInputDefinitions(container.inputs, suggestions);

    return {
        servers,
        inputs,
        warnings: Array.from(new Set(warnings)),
        errors: [],
    };
}
