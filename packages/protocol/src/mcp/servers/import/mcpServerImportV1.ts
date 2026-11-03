import { z } from 'zod/mini';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { ValueRefV1Schema, type ValueRefV1 } from '../../../valueRefs/valueRefV1.js';
import { PERSONAL_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1, PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1,
    PersonalSavedSecretCreateInputObjectV1Schema } from '../../../account/settings/personalSavedSecretActionsV1.js';
import { McpServerCatalogEntryV1Schema, type McpServerCatalogEntryV1 } from '../settingsV1.js';
import type { DetectedMcpServerV1 } from '../daemonRpcV1.js';
import { isMcpImportSecretNameV1, mcpImportValueInputIdV1,
    type ImportedMcpServerDraftV1, type ImportedMcpInputDefinitionV1, type ImportedMcpDraftValueV1,
    type ParseMcpServerImportV1Result } from './parseMcpServerImportV1.js';

export const McpImportValueChoiceV1Schema = lazyZodSchema(() => z.union([
    ValueRefV1Schema,
    z.extend(PersonalSavedSecretCreateInputObjectV1Schema, { t: z.literal('createSecret') }),
    z.extend(z.omit(PersonalSavedSecretCreateInputObjectV1Schema, { value: true }), { t: z.literal('saveSecret') }),
]));
export type McpImportValueChoiceV1 = z.infer<typeof McpImportValueChoiceV1Schema>;
export const McpImportValuesV1Schema = lazyZodSchema(() => z.record(z.string(), McpImportValueChoiceV1Schema));
export type McpImportValuesV1 = z.infer<typeof McpImportValuesV1Schema>;
const identity = () => z.string().check(z.minLength(1));
const importInputMetadata = lazyZodSchema(() => z.strictObject({ inputId: identity(), title: z.string(), description: z.optional(z.string()),
    secret: z.boolean(), suggestedEnvVarName: z.string() }));
const duplicate = lazyZodSchema(() => z.strictObject({ name: z.string(), serverId: z.optional(identity()), duplicateOf: z.optional(z.string()) }));
export const McpImportMovedSecretV1Schema = lazyZodSchema(() => z.strictObject({ inputId: identity(), secretId: identity(), secretRef: identity() }));
export type McpImportMovedSecretV1 = z.infer<typeof McpImportMovedSecretV1Schema>;
export const McpImportPreviewV1Schema = lazyZodSchema(() => z.strictObject({
    servers: z.array(z.strictObject({ name: z.string(), title: z.optional(z.string()), transport: z.enum(['stdio', 'http', 'sse']),
        envNames: z.array(z.string()), headerNames: z.array(z.string()) })),
    inputs: z.array((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(importInputMetadata, { suggestedValue: z.optional(z.string()), literalSecret: z.optional(z.literal(true)) }))),
    missingValues: z.array(importInputMetadata), duplicates: z.array(duplicate),
    movedSecrets: z.array(z.strictObject({ inputId: identity() })), warnings: z.array(z.string()), errors: z.array(z.string()),
}));
export const McpImportCommitV1Schema = lazyZodSchema(() => z.strictObject({ ok: z.literal(true), revision: z.number().check(z.int(), z.nonnegative()),
    serverIds: z.array(identity()), duplicates: z.array(duplicate), movedSecrets: z.array(McpImportMovedSecretV1Schema) }));
type Catalog = Readonly<{ servers: readonly McpServerCatalogEntryV1[] }>;
export type McpImportDuplicateV1 = Readonly<{ name: string; serverId?: string; duplicateOf?: string }>;
export type McpImportPreviewV1 = z.infer<typeof McpImportPreviewV1Schema>;

/** Same identity for catalog duplicate detection and Found's "In Happier" projection. */
export function mcpServerImportIdentityV1(server: Readonly<{ transport: ImportedMcpServerDraftV1['transport'];
    stdio?: Readonly<{ command: string; args: readonly string[] }>; remote?: Readonly<{ url: string }> }>): string {
    if (server.transport === 'stdio') {
        const command = server.stdio?.command.trim().replace(/\\/gu, '/');
        return JSON.stringify(['stdio', command, server.stdio?.args ?? []]);
    }
    try { return JSON.stringify(['remote', new URL(server.remote?.url ?? '').href]); }
    catch { return JSON.stringify(['remote', server.remote?.url]); }
}

function selectDrafts(parsed: ParseMcpServerImportV1Result, catalog: Catalog) {
    const identities = new Map<string, { serverId?: string; duplicateOf?: string }>(catalog.servers.map(server => [mcpServerImportIdentityV1(server), { serverId: server.id }]));
    const drafts: ImportedMcpServerDraftV1[] = [];
    const duplicates: McpImportDuplicateV1[] = [];
    for (const draft of parsed.servers) {
        const identity = mcpServerImportIdentityV1(draft);
        const existing = identities.get(identity);
        if (existing) { duplicates.push({ name: draft.name, ...existing }); continue; }
        identities.set(identity, { duplicateOf: draft.name });
        drafts.push(draft);
    }
    return { drafts, duplicates };
}
function draftInputs(draft: ImportedMcpServerDraftV1) {
    return [...Object.values(draft.env), ...Object.values(draft.remote?.headers ?? {}), ...(draft.remote?.urlTemplate ? [draft.remote.urlTemplate] : [])].flatMap(value => value.t === 'input' ? [value.inputId]
        : value.t === 'template' ? Object.values(value.vars).map(variable => variable.inputId) : []);
}
function withoutValue(input: ImportedMcpInputDefinitionV1): Omit<ImportedMcpInputDefinitionV1, 'suggestedValue'> {
    const { suggestedValue: _value, ...metadata } = input;
    return metadata;
}
function admissibleChoice(choice: unknown, input: ImportedMcpInputDefinitionV1): choice is McpImportValueChoiceV1 {
    const parsed = McpImportValueChoiceV1Schema.safeParse(choice);
    if (!parsed.success || parsed.data.t === 'sessionAttested') return false;
    const admitted = parsed.data;
    if (admitted.t === 'saveSecret') return Boolean(input.secret && input.suggestedValue?.length);
    if (admitted.t === 'template') {
        return [...admitted.template.matchAll(/\{([^{}]+)\}/gu)].every(match => Object.hasOwn(admitted.vars, match[1]!));
    }
    return true;
}

/** Preview never discloses a literal secret; every named value needs explicit caller admission. */
export function prepareMcpServerImportV1(params: Readonly<{ parsed: ParseMcpServerImportV1Result; catalog: Catalog; values?: McpImportValuesV1 }>): McpImportPreviewV1 {
    const { drafts, duplicates } = selectDrafts(params.parsed, params.catalog);
    const required = new Set(drafts.flatMap(draftInputs));
    const inputs = params.parsed.inputs.filter(input => required.has(input.inputId));
    const missingValues = inputs.filter(input => !Object.hasOwn(params.values ?? {}, input.inputId)
        || !admissibleChoice(params.values![input.inputId], input)).map(withoutValue);
    return { servers: drafts.map(draft => ({ name: draft.name, ...(draft.title ? { title: draft.title } : {}), transport: draft.transport,
        envNames: Object.keys(draft.env), headerNames: Object.keys(draft.remote?.headers ?? {}) })),
        inputs: inputs.map(input => input.secret ? { ...withoutValue(input), ...(input.suggestedValue !== undefined ? { literalSecret: true as const } : {}) } : input),
        missingValues, duplicates, movedSecrets: inputs.filter(input => input.secret && input.suggestedValue !== undefined).map(input => ({ inputId: input.inputId })),
        warnings: params.parsed.warnings, errors: params.parsed.errors };
}

export function prepareDetectedMcpServerImportV1(items: readonly DetectedMcpServerV1[], machineId: string): ParseMcpServerImportV1Result {
    const inputs: ImportedMcpInputDefinitionV1[] = [];
    const values = (name: string, target: 'env' | 'header', keys: readonly string[]) => Object.fromEntries([...new Set(keys)].map(key => {
        const inputId = mcpImportValueInputIdV1(name, target, key);
        inputs.push({ inputId, title: key, secret: isMcpImportSecretNameV1(key), suggestedEnvVarName: key.replace(/[^A-Za-z0-9_]/gu, '_').toUpperCase() });
        return [key, { t: 'input', inputId } as const];
    }));
    return { servers: items.map(item => ({ name: item.name, transport: item.transport,
        ...(item.stdio ? { stdio: item.stdio } : {}),
        ...(item.remote ? { remote: { url: item.remote.url, headers: values(item.name, 'header', item.remote.headers) } } : {}),
        env: values(item.name, 'env', item.envKeys), enabled: item.enabled !== false, warnings: [],
        origin: { kind: 'machine' as const, machineId, agentId: item.provider } })), inputs, errors: [], warnings: [] };
}

export type McpServerImportPreparationV1 = Readonly<{ ok: true; entries: readonly McpServerCatalogEntryV1[]; duplicates: readonly McpImportDuplicateV1[];
    movedSecrets: readonly McpImportMovedSecretV1[] }>
    | (Omit<McpImportPreviewV1, 'movedSecrets'> & Readonly<{ ok: false; code: 'invalid_import' | 'missing_values' | 'secret_creation_failed';
        movedSecrets: readonly McpImportMovedSecretV1[]; cause?: unknown }>);

/** Create secrets only after the entire import is valid; the caller owns one catalog CAS with reach. */
export async function materializeMcpServerImportV1(params: Readonly<{
    parsed: ParseMcpServerImportV1Result; catalog: Catalog; values?: McpImportValuesV1; nowMs: number; newId: () => string;
    createSecret: (input: z.infer<typeof PERSONAL_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1['secrets.create']>) => Promise<z.infer<typeof PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1['secrets.create']>>;
}>): Promise<McpServerImportPreparationV1> {
    const preview = prepareMcpServerImportV1(params);
    if (preview.errors.length || preview.missingValues.length) return { ok: false,
        code: preview.errors.length ? 'invalid_import' : 'missing_values', ...preview, movedSecrets: [] };
    const { drafts, duplicates } = selectDrafts(params.parsed, params.catalog);
    const resolved = new Map<string, ValueRefV1>();
    const metadata = new Map(params.parsed.inputs.map(input => [input.inputId, input]));
    const resolve = (value: ImportedMcpDraftValueV1): ValueRefV1 => {
        if (value.t === 'literal') return value;
        if (value.t === 'input') return resolved.get(value.inputId)!;
        return { t: 'template', template: value.template, vars: Object.fromEntries(Object.entries(value.vars).map(([name, variable]) => {
            const ref = resolved.get(variable.inputId)!;
            if (ref.t !== 'literal' && ref.t !== 'savedSecret') throw new Error('invalid-import-template-value');
            return [name, ref];
        })) };
    };
    const names = new Set(params.catalog.servers.map(server => server.name));
    const entries = drafts.map(draft => {
        const base = draft.name.trim().toLowerCase().replace(/[^a-z0-9_-]+/gu, '_').replace(/^_+|_+$/gu, '') || 'server';
        let name = base;
        for (let suffix = 2; names.has(name) || !McpServerCatalogEntryV1Schema.shape.name.safeParse(name).success; suffix += 1) name = `${base}_${suffix}`;
        names.add(name);
        return { id: params.newId(), name, ...(draft.title ? { title: draft.title } : name !== draft.name ? { title: draft.name } : {}),
            ...(draft.description ? { description: draft.description } : {}), transport: draft.transport,
            ...(draft.stdio ? { stdio: draft.stdio } : {}), ...(draft.remote ? { remote: { url: draft.remote.url, headers: {} } } : {}),
            env: {}, ...(draft.origin ? { origin: draft.origin } : {}), createdAt: params.nowMs, updatedAt: params.nowMs } satisfies McpServerCatalogEntryV1;
    });
    // Validate commands, URLs, keys and template choices before persistent secret creation.
    for (const input of preview.inputs) {
        const choice = params.values![input.inputId]!;
        resolved.set(input.inputId, choice.t === 'createSecret' || choice.t === 'saveSecret'
            ? { t: 'savedSecret', secretId: 'pending-secret' } : choice);
    }
    try {
        entries.forEach((entry, index) => {
            const draft = drafts[index]!;
            const env = Object.fromEntries(Object.entries(draft.env).map(([key, value]) => [key, resolve(value)]));
            const headers = Object.fromEntries(Object.entries(draft.remote?.headers ?? {}).map(([key, value]) => [key, resolve(value)]));
            McpServerCatalogEntryV1Schema.parse({ ...entry, env, ...(entry.remote ? { remote: { ...entry.remote, headers,
                ...(draft.remote?.urlTemplate ? { urlTemplate: resolve(draft.remote.urlTemplate) } : {}) } } : {}) });
        });
    } catch { return { ok: false, code: 'invalid_import', ...preview, errors: ['invalid-server-configuration'], movedSecrets: [] }; }
    const movedSecrets: McpImportMovedSecretV1[] = [];
    for (const input of preview.inputs) {
        const choice = params.values![input.inputId]!;
        if (choice.t !== 'createSecret' && choice.t !== 'saveSecret') continue;
        try {
            const { secretId, secretRef } = PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1['secrets.create'].parse(await params.createSecret({ name: choice.name,
                ...(choice.kind ? { kind: choice.kind } : {}), value: choice.t === 'createSecret' ? choice.value : metadata.get(input.inputId)!.suggestedValue! }));
            movedSecrets.push({ inputId: input.inputId, secretId, secretRef });
            resolved.set(input.inputId, { t: 'savedSecret', secretId: secretRef });
        } catch (cause) { return { ok: false, code: 'secret_creation_failed', ...preview, movedSecrets, cause }; }
    }
    return { ok: true, entries: entries.map((entry, index) => {
        const draft = drafts[index]!;
        return McpServerCatalogEntryV1Schema.parse({ ...entry,
            env: Object.fromEntries(Object.entries(draft.env).map(([key, value]) => [key, resolve(value)])),
            ...(entry.remote ? { remote: { ...entry.remote,
                headers: Object.fromEntries(Object.entries(draft.remote?.headers ?? {}).map(([key, value]) => [key, resolve(value)])),
                ...(draft.remote?.urlTemplate ? { urlTemplate: resolve(draft.remote.urlTemplate) } : {}) } } : {}) });
    }), duplicates, movedSecrets };
}
