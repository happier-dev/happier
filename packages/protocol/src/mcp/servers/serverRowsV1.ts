import { z } from 'zod';
import tweetnacl from 'tweetnacl';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { isAccountScopedBlobCiphertextForKind } from '../../crypto/accountScopedCipherEnvelope.js';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext, type AccountScopedCryptoMaterial } from '../../crypto/accountScopedCipher.js';
import { appendSavedSecretReferencePathV1, listSavedSecretReferenceCarrierPathsV1 } from '../../account/settings/savedSecretReferenceV1.js';
import { McpServerCatalogEntryV1Schema, McpServerBindingV1Schema, refineMcpServerCatalogV1,
  type McpServerCatalogEntryV1, type McpServerBindingV1, type McpValueRefV1 } from './settingsV1.js';

export const MCP_SERVER_CATALOG_ACCOUNT_KEY_V1 = '@happier/account/mcp/v1/catalog' as const;
export const MCP_SERVER_CATALOG_ROWS_ROUTE_V1 = '/v1/account/entity-rows/mcp' as const;
export const MCP_SERVER_CATALOG_ACCOUNT_CIPHER_KIND_V1 = 'account_mcp_catalog' as const;

export const McpServerCatalogV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1), servers: z.array(McpServerCatalogEntryV1Schema), bindings: z.array(McpServerBindingV1Schema),
}).strict().superRefine(refineMcpServerCatalogV1));
export type McpServerCatalogV1 = z.infer<typeof McpServerCatalogV1Schema>;
export const StoredMcpServerCatalogV1Schema = createStoredReadSchema(McpServerCatalogV1Schema);
export const McpServerCatalogContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.object({ t: z.literal('plain'), v: McpServerCatalogV1Schema }).strict(),
  z.object({ t: z.literal('encrypted'), c: z.string().min(1) }).strict(),
]));
export type McpServerCatalogContentV1 = z.infer<typeof McpServerCatalogContentV1Schema>;
// Preserve the original JSON until the domain opener has diagnosed individual
// entries and recognizable reference carriers; projecting here loses evidence.
export const StoredMcpServerCatalogContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.object({ t: z.literal('plain'), v: z.unknown() }).strict(),
  z.object({ t: z.literal('encrypted'), c: z.string().min(1) }).strict(),
]));
export type StoredMcpServerCatalogContentV1 = z.infer<typeof StoredMcpServerCatalogContentV1Schema>;
export type McpServerCatalogDiagnosticV1 = Readonly<{ path: string; reason: 'invalid-stored-content' | 'unclassified-reference' }>;
export const McpServerCatalogDiagnosticV1Schema = lazyZodSchema(() => z.object({
  path: z.string(), reason: z.enum(['invalid-stored-content', 'unclassified-reference']),
}).strict());
export type McpServerCatalogOpenResultV1 = Readonly<{ status: 'opened'; catalog: McpServerCatalogV1 }>
  | Readonly<{ status: 'partial'; catalog: McpServerCatalogV1; diagnostics: readonly McpServerCatalogDiagnosticV1[] }>
  | Readonly<{ status: 'unavailable'; reason: 'account-mode-mismatch' | 'encryption-material-unavailable' | 'invalid-stored-content' }>;

export function assertMcpServerCatalogContentForModeV1(content: StoredMcpServerCatalogContentV1, mode: 'plain' | 'e2ee'): void {
  if ((mode === 'plain') !== (content.t === 'plain') || (content.t === 'encrypted'
    && !isAccountScopedBlobCiphertextForKind({ kind: MCP_SERVER_CATALOG_ACCOUNT_CIPHER_KIND_V1, ciphertext: content.c }))) {
    throw new Error('account-mode-mismatch');
  }
}

const storedServer = createStoredReadSchema(McpServerCatalogEntryV1Schema);
const storedBinding = createStoredReadSchema(McpServerBindingV1Schema);

/** Malformed independent entries remain diagnostic; they never authorize activation. */
export function projectStoredMcpServerCatalogV1(value: unknown): McpServerCatalogOpenResultV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { status: 'unavailable', reason: 'invalid-stored-content' };
  const raw = value as Record<string, unknown>;
  if (raw.v !== 1 || !Array.isArray(raw.servers) || !Array.isArray(raw.bindings)) return { status: 'unavailable', reason: 'invalid-stored-content' };
  const diagnostics: McpServerCatalogDiagnosticV1[] = [];
  const candidates: Array<{ entry: McpServerCatalogEntryV1; index: number }> = [];
  raw.servers.forEach((entry, index) => {
    const parsed = storedServer.safeParse(entry);
    if (parsed.success) candidates.push({ entry: parsed.data, index });
    else diagnostics.push({ path: `servers[${index}]`, reason: 'invalid-stored-content' });
  });
  const idCounts = new Map<string, number>();
  const nameCounts = new Map<string, number>();
  candidates.forEach(({ entry }) => {
    idCounts.set(entry.id, (idCounts.get(entry.id) ?? 0) + 1);
    nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
  });
  const servers: McpServerCatalogEntryV1[] = [];
  for (const candidate of candidates) {
    if (idCounts.get(candidate.entry.id) !== 1 || nameCounts.get(candidate.entry.name) !== 1) {
      diagnostics.push({ path: `servers[${candidate.index}]`, reason: 'invalid-stored-content' });
    } else servers.push(candidate.entry);
  }
  const serverIds = new Set(servers.map(server => server.id));
  const parsedBindings = raw.bindings.map((binding, index) => ({ parsed: storedBinding.safeParse(binding), index }));
  const bindingIdCounts = new Map<string, number>();
  parsedBindings.forEach(({ parsed }) => {
    if (parsed.success) bindingIdCounts.set(parsed.data.id, (bindingIdCounts.get(parsed.data.id) ?? 0) + 1);
  });
  const bindings: McpServerBindingV1[] = [];
  for (const { parsed, index } of parsedBindings) {
    if (!parsed.success || !serverIds.has(parsed.data.serverId) || bindingIdCounts.get(parsed.data.id) !== 1) {
      diagnostics.push({ path: `bindings[${index}]`, reason: 'invalid-stored-content' });
    } else bindings.push(parsed.data);
  }
  const catalog: McpServerCatalogV1 = { v: 1, servers, bindings };
  const admittedPaths = new Set(listMcpServerCatalogSavedSecretRefsV1(catalog).map(ref => ref.path));
  // Projection changes indices when malformed neighbors are removed. Recognize
  // admitted references in their original positions before comparing carriers.
  candidates.forEach(({ entry, index }) => {
    for (const ref of listMcpServerCatalogSavedSecretRefsV1({ v: 1, servers: [entry], bindings: [] })) {
      admittedPaths.add(ref.path.replace(/^servers\[0\]/u, `servers[${index}]`));
    }
  });
  parsedBindings.forEach(({ parsed, index }) => {
    if (parsed.success) for (const ref of listMcpServerCatalogSavedSecretRefsV1({ v: 1, servers: [], bindings: [parsed.data] })) {
      admittedPaths.add(ref.path.replace(/^bindings\[0\]/u, `bindings[${index}]`));
    }
  });
  for (const path of listSavedSecretReferenceCarrierPathsV1(raw)) {
    if (!admittedPaths.has(path)) diagnostics.push({ path, reason: 'unclassified-reference' });
  }
  return diagnostics.length ? { status: 'partial', catalog, diagnostics } : { status: 'opened', catalog };
}

export function openMcpServerCatalogContentV1(input: Readonly<{
  mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null; content: unknown;
}>): McpServerCatalogOpenResultV1 {
  const content = StoredMcpServerCatalogContentV1Schema.safeParse(input.content);
  if (!content.success) return { status: 'unavailable', reason: 'invalid-stored-content' };
  try { assertMcpServerCatalogContentForModeV1(content.data, input.mode); }
  catch { return { status: 'unavailable', reason: 'account-mode-mismatch' }; }
  if (input.mode === 'plain' && input.material !== null) return { status: 'unavailable', reason: 'account-mode-mismatch' };
  if (content.data.t === 'plain') return projectStoredMcpServerCatalogV1(content.data.v);
  if (!input.material) return { status: 'unavailable', reason: 'encryption-material-unavailable' };
  const value = openAccountScopedBlobCiphertext({ kind: MCP_SERVER_CATALOG_ACCOUNT_CIPHER_KIND_V1,
    material: input.material, ciphertext: content.data.c })?.value;
  return projectStoredMcpServerCatalogV1(value);
}

export function sealMcpServerCatalogContentV1(input: Readonly<{
  catalog: McpServerCatalogV1; mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null;
  randomBytes?: (length: number) => Uint8Array;
}>): McpServerCatalogContentV1 {
  const catalog = McpServerCatalogV1Schema.parse(input.catalog);
  if (input.mode === 'plain') {
    if (input.material !== null) throw new Error('account-mode-mismatch');
    return { t: 'plain', v: catalog };
  }
  if (!input.material) throw new Error('encryption-material-unavailable');
  return { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: MCP_SERVER_CATALOG_ACCOUNT_CIPHER_KIND_V1,
    material: input.material, payload: catalog, randomBytes: input.randomBytes ?? tweetnacl.randomBytes }) };
}

const revision = lazyZodSchema(() => z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
export const McpServerCatalogRowFailureV1Schema = lazyZodSchema(() => z.object({
  status: z.enum(['account-not-found', 'account-inconsistent', 'account-mode-mismatch', 'invalid-stored-content', 'invalid-reference']),
  reason: z.string().optional(),
}).strict());
export const McpServerCatalogRowReadResponseV1Schema = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('present'), revision, content: StoredMcpServerCatalogContentV1Schema }).strict(),
  z.object({ status: z.literal('absent') }).strict(), z.object({ status: z.literal('deleted'), revision }).strict(),
  McpServerCatalogRowFailureV1Schema,
]));
export type McpServerCatalogRowReadResponseV1 = z.infer<typeof McpServerCatalogRowReadResponseV1Schema>;
export const McpServerCatalogRowMutationV1Schema = lazyZodSchema(() => z.object({
  expectedRevision: z.union([revision, z.literal('absent')]), content: McpServerCatalogContentV1Schema.nullable(),
  sourceSettingsVersion: revision.optional(), referencedSavedSecretIds: z.array(z.string().min(1)).default([]),
  savedSecretRevisions: z.array(z.object({ resourceId: z.string().min(1), expectedRevision: revision }).strict()).default([]),
}).strict().superRefine((mutation, context) => {
  if (mutation.expectedRevision === 'absent' && (mutation.sourceSettingsVersion === undefined || mutation.content === null)) {
    context.addIssue({ code: 'custom', path: ['sourceSettingsVersion'], message: 'First authority requires captured source currentness' });
  }
  if (mutation.sourceSettingsVersion !== undefined && (mutation.expectedRevision !== 'absent' || mutation.content === null)) {
    context.addIssue({ code: 'custom', path: ['sourceSettingsVersion'], message: 'Source admission initializes authority only' });
  }
}));
export type McpServerCatalogRowMutationV1 = z.infer<typeof McpServerCatalogRowMutationV1Schema>;
export const McpServerCatalogRowMutationResponseV1Schema = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('updated'), revision, cursor: revision }).strict(),
  z.object({ status: z.literal('conflict'), revision: z.number().int().min(-1) }).strict(),
  z.object({ status: z.literal('settings-conflict'), revision }).strict(), McpServerCatalogRowFailureV1Schema,
]));
export type McpServerCatalogRowMutationResponseV1 = z.infer<typeof McpServerCatalogRowMutationResponseV1Schema>;
export const AccountEncryptionMigrateMcpServerCatalogDirectiveV1Schema = lazyZodSchema(() => z.object({
  expectedRevision: revision, content: McpServerCatalogContentV1Schema.nullable(),
}).strict());
export type AccountEncryptionMigrateMcpServerCatalogDirectiveV1 = z.infer<typeof AccountEncryptionMigrateMcpServerCatalogDirectiveV1Schema>;
export const AccountEncryptionMigrateMcpServerCatalogResultV1Schema = lazyZodSchema(() => z.object({
  revision, content: StoredMcpServerCatalogContentV1Schema.nullable(),
}).strict());
export type AccountEncryptionMigrateMcpServerCatalogResultV1 = z.infer<typeof AccountEncryptionMigrateMcpServerCatalogResultV1Schema>;

export function listMcpServerCatalogSavedSecretRefsV1(catalog: McpServerCatalogV1): readonly Readonly<{ path: string; secretId: string }>[] {
  const refs: Array<{ path: string; secretId: string }> = [];
  const visit = (values: Readonly<Record<string, McpValueRefV1 | null>> | undefined, path: string) => {
    for (const [key, value] of Object.entries(values ?? {})) if (value?.t === 'savedSecret') {
      refs.push({ path: appendSavedSecretReferencePathV1(path, key), secretId: value.secretId });
    }
  };
  catalog.servers.forEach((entry, index) => {
    visit(entry.env, `servers[${index}].env`); visit(entry.remote?.headers, `servers[${index}].remote.headers`);
  });
  catalog.bindings.forEach((binding, index) => {
    visit(binding.overrides?.envPatch, `bindings[${index}].overrides.envPatch`);
    visit(binding.overrides?.remote?.headersPatch, `bindings[${index}].overrides.remote.headersPatch`);
  });
  return refs;
}

export function remapMcpServerCatalogSavedSecretReferencesV1(catalog: McpServerCatalogV1, mapping: Readonly<Record<string, string>>): McpServerCatalogV1 {
  const rewrite = <T extends McpValueRefV1 | null>(value: T): T | McpValueRefV1 => value?.t === 'savedSecret' && Object.hasOwn(mapping, value.secretId)
    ? { ...value, secretId: mapping[value.secretId]! } : value;
  const values = <T extends McpValueRefV1 | null>(input: Readonly<Record<string, T>>): Record<string, T | McpValueRefV1> =>
    Object.fromEntries(Object.entries(input).map(([key, value]) => [key, rewrite(value)]));
  return McpServerCatalogV1Schema.parse({ ...catalog,
    servers: catalog.servers.map(entry => ({ ...entry, env: values(entry.env),
      ...(entry.remote ? { remote: { ...entry.remote, headers: values(entry.remote.headers) } } : {}) })),
    bindings: catalog.bindings.map(binding => ({ ...binding, ...(binding.overrides ? { overrides: { ...binding.overrides,
      ...(binding.overrides.envPatch ? { envPatch: values(binding.overrides.envPatch) } : {}),
      ...(binding.overrides.remote ? { remote: { ...binding.overrides.remote,
        ...(binding.overrides.remote.headersPatch ? { headersPatch: values(binding.overrides.remote.headersPatch) } : {}) } } : {}),
    } } : {}) })),
  });
}
export function rewriteMcpServerCatalogSavedSecretRefsV1(catalog: McpServerCatalogV1, from: string, to: string): McpServerCatalogV1 {
  return remapMcpServerCatalogSavedSecretReferencesV1(catalog, { [from]: to });
}
