import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { AcpCatalogRecordV1Schema, AcpCatalogRowMutationV1Schema } from './catalogSchemasV1.js';

import {
  AcpBackendDefinitionV1Schema,
  AcpBackendCapabilitiesV1Schema,
  AcpConfiguredRuntimeV1Schema,
  AcpBackendCompatibilityV1Schema,
  AcpCatalogSettingsV1Schema,
  type AcpBackendDefinitionV1,
  type AcpCatalogSettingsV1,
} from './settingsV1.js';

/**
 * The semantic mutation owner of the Account's custom ACP catalog. The Settings editor
 * and the `agents.acp.backends.*` actions both apply their changes through these functions, so a
 * backend authored by hand and one authored by an agent are validated and stored identically.
 * Persistence, encryption and compare-and-set stay with each host's canonical ACP row owner;
 * the v2 shape below is an ephemeral authoring projection, not a Settings write.
 */

/** The stored catalog, or an empty one when the stored value is missing or unreadable. */
export function normalizeAcpCatalogSettingsV1(raw: unknown): AcpCatalogSettingsV1 {
  const parsed = AcpCatalogSettingsV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : { v: 2, backends: [] };
}

/**
 * An authored backend: the stored definition, with timestamps optional (they are stamped on
 * write). Loosely typed at the boundary because text fields are trimmed before validation.
 */
export const AcpBackendAuthoringInputV1Schema = lazyZodSchema(() => z.object({
  id: z.string(),
  name: z.string(),
  title: z.string(),
  description: z.string().optional(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: AcpBackendDefinitionV1Schema.shape.env.optional(),
  auth: z.object({
    support: z.string(),
    machineLoginKey: z.string().optional(),
    docsUrl: z.string().optional(),
    loginCommand: z.object({ command: z.string(), args: z.array(z.string()).optional() }).strict().optional(),
    envVars: z.array(z.string()).optional(),
  }).strict().optional(),
  runtime: AcpConfiguredRuntimeV1Schema.optional(),
  compatibility: AcpBackendCompatibilityV1Schema.optional(),
  defaultMode: z.string().optional(),
  defaultModel: z.string().optional(),
  capabilities: AcpBackendCapabilitiesV1Schema.partial().strict().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
}).strict());
export type AcpBackendAuthoringInputV1 = z.input<typeof AcpBackendAuthoringInputV1Schema>;

export type AcpCatalogMutationErrorCodeV1 =
  | 'acp_catalog_unavailable'
  | 'acp_backend_invalid'
  | 'acp_backend_name_conflict'
  | 'acp_backend_id_conflict'
  | 'acp_backend_not_found';

/**
 * A refused write names the authored fields at fault (`id`, `title`, `command`, `env`,
 * `auth.docsUrl`, …) so an editor can show each error beside its field.
 */
export type AcpBackendUpsertResultV1 =
  | Readonly<{ ok: true; settings: AcpCatalogSettingsV1; backend: AcpBackendDefinitionV1 }>
  | Readonly<{ ok: false; code: 'acp_backend_invalid'; message: string; fields: readonly string[] }>
  | Readonly<{ ok: false; code: 'acp_backend_name_conflict'; message: string; fields: readonly ['name'] }>
  | Readonly<{ ok: false; code: 'acp_backend_id_conflict'; message: string; fields: readonly ['id'] }>
  | Readonly<{ ok: false; code: 'acp_catalog_unavailable'; message: string; fields: readonly ['catalog'] }>;

export type AcpBackendDeleteResultV1 =
  | Readonly<{ ok: true; settings: AcpCatalogSettingsV1 }>
  | Readonly<{ ok: false; code: 'acp_backend_not_found' | 'acp_catalog_unavailable' }>;

function readWritableCatalog(raw: unknown): AcpCatalogSettingsV1 | null {
  if (raw === undefined) return { v: 2, backends: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const parsed = AcpCatalogSettingsV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function trimmedOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** The authored field an issue belongs to: `id`, `auth.docsUrl`, or `env` for any variable. */
function resolveIssueField(path: readonly PropertyKey[]): string {
  const [head, next] = path;
  if (head === 'auth' && typeof next === 'string') return `auth.${next}`;
  return String(head ?? '');
}

/**
 * Adds a backend or replaces the one with the same id; names stay unique across the catalog.
 * `create` refuses an id that is already taken, so a new backend never silently replaces one.
 */
export function applyAcpBackendUpsertV1(input: Readonly<{
  settings: unknown;
  backend: AcpBackendAuthoringInputV1;
  nowMs: number;
  mode?: 'upsert' | 'create';
}>): AcpBackendUpsertResultV1 {
  const settings = readWritableCatalog(input.settings);
  if (!settings) return { ok: false, code: 'acp_catalog_unavailable', message: 'ACP catalog requires repair before editing', fields: ['catalog'] };
  const authored = input.backend;
  const id = authored.id.trim();
  const previous = settings.backends.find((entry) => entry.id === id) ?? null;
  if (previous && input.mode === 'create') {
    return { ok: false, code: 'acp_backend_id_conflict', message: `Duplicate ACP backend id: ${id}`, fields: ['id'] };
  }
  const parsed = AcpBackendDefinitionV1Schema.safeParse({
    ...(previous?.runtime ? { runtime: previous.runtime } : {}),
    ...(previous?.compatibility ? { compatibility: previous.compatibility } : {}),
    ...authored,
    id,
    name: authored.name.trim(),
    title: authored.title.trim(),
    description: trimmedOrUndefined(authored.description),
    command: authored.command.trim(),
    auth: authored.auth
      ? {
        ...authored.auth,
        machineLoginKey: trimmedOrUndefined(authored.auth.machineLoginKey),
        docsUrl: trimmedOrUndefined(authored.auth.docsUrl),
        loginCommand: authored.auth.loginCommand?.command?.trim()
          ? { command: authored.auth.loginCommand.command.trim(), args: authored.auth.loginCommand.args }
          : undefined,
      }
      : undefined,
    createdAt: authored.createdAt ?? previous?.createdAt ?? input.nowMs,
    updatedAt: authored.updatedAt ?? input.nowMs,
  });
  if (!parsed.success) {
    return {
      ok: false,
      code: 'acp_backend_invalid',
      message: parsed.error.issues[0]?.message ?? 'Invalid ACP backend',
      fields: [...new Set(parsed.error.issues.map((issue) => resolveIssueField(issue.path)))],
    };
  }
  const backend = parsed.data;
  if (settings.backends.some((entry) => entry.id !== backend.id && entry.name === backend.name)) {
    return { ok: false, code: 'acp_backend_name_conflict', message: `Duplicate ACP backend name: ${backend.name}`, fields: ['name'] };
  }
  const backends = previous
    ? settings.backends.map((entry) => (entry.id === backend.id ? backend : entry))
    : [...settings.backends, backend];
  return { ok: true, settings: { ...settings, backends }, backend };
}

/**
 * An id (and name) for a backend from its display name: lower-case words joined by `-`, accents
 * dropped, suffixed `-2`, `-3`, … until no stored backend uses it as an id or a name. Empty when the
 * display name has no letters or digits to derive from, so the author types one.
 */
export function suggestAcpBackendIdV1(input: Readonly<{ title: string; settings: unknown }>): string {
  const base = input.title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '');
  if (!base) return '';
  const taken = new Set(normalizeAcpCatalogSettingsV1(input.settings).backends.flatMap((entry) => [entry.id, entry.name]));
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Removes the backend with this id. */
export function applyAcpBackendDeleteV1(input: Readonly<{
  settings: unknown;
  backendId: string;
}>): AcpBackendDeleteResultV1 {
  const settings = readWritableCatalog(input.settings);
  if (!settings) return { ok: false, code: 'acp_catalog_unavailable' };
  const backendId = input.backendId.trim();
  if (!settings.backends.some((entry) => entry.id === backendId)) return { ok: false, code: 'acp_backend_not_found' };
  return { ok: true, settings: { ...settings, backends: settings.backends.filter((entry) => entry.id !== backendId) } };
}

/** `agents.acp.backends.upsert`: add or replace one custom ACP agent in the Account catalog. */
const capturedRevisionFields = () => ({
  expectedRevision: AcpCatalogRowMutationV1Schema.shape.expectedRevision.optional(),
  sourceSettingsVersion: AcpCatalogRowMutationV1Schema.shape.sourceSettingsVersion,
});
function validateCapturedRevision(input: Readonly<{ expectedRevision?: number | 'absent'; sourceSettingsVersion?: number }>, context: z.RefinementCtx): void {
  if (input.expectedRevision === 'absent' && input.sourceSettingsVersion === undefined) {
    context.addIssue({ code: 'custom', path: ['sourceSettingsVersion'], message: 'An absent draft requires its captured Settings version' });
  }
  if (input.sourceSettingsVersion !== undefined && input.expectedRevision !== 'absent') {
    context.addIssue({ code: 'custom', path: ['sourceSettingsVersion'], message: 'Settings version is only valid for an absent catalog' });
  }
}
export const AgentsAcpBackendsUpsertInputV1Schema = lazyZodSchema(() => z.object({
  backend: AcpBackendAuthoringInputV1Schema,
  ...capturedRevisionFields(),
}).strict().superRefine(validateCapturedRevision));
export type AgentsAcpBackendsUpsertInputV1 = z.infer<typeof AgentsAcpBackendsUpsertInputV1Schema>;
/** Private configured definition; default execution observations redact its executable fields. */
export const AgentsAcpBackendsGetInputV1Schema = lazyZodSchema(() => z.object({
  backendId: z.string().trim().min(1),
}).strict());
export type AgentsAcpBackendsGetInputV1 = z.infer<typeof AgentsAcpBackendsGetInputV1Schema>;
export const AgentsAcpBackendsGetOutputV1Schema = lazyZodSchema(() => z.object({
  backend: AcpCatalogRecordV1Schema.shape.definitions.element,
  revision: z.union([z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), z.literal('absent')]),
}).strict());
export type AgentsAcpBackendsGetOutputV1 = z.infer<typeof AgentsAcpBackendsGetOutputV1Schema>;

export const AcpCatalogCleanupV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('complete') }).strict(),
  z.object({ status: z.literal('cleanup-pending'), reason: z.literal('history-incomplete') }).strict(),
]));
export type AcpCatalogCleanupV1 = z.infer<typeof AcpCatalogCleanupV1Schema>;

export const AgentsAcpBackendsUpsertOutputV1Schema = lazyZodSchema(() => z.object({
  backend: AcpBackendDefinitionV1Schema,
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  cleanup: AcpCatalogCleanupV1Schema.optional(),
}).strict());

/** `agents.acp.backends.delete`: remove one custom ACP agent from the Account catalog. */
export const AgentsAcpBackendsDeleteInputV1Schema = lazyZodSchema(() => z.object({
  backendId: z.string().trim().min(1),
  ...capturedRevisionFields(),
}).strict().superRefine(validateCapturedRevision));
export type AgentsAcpBackendsDeleteInputV1 = z.infer<typeof AgentsAcpBackendsDeleteInputV1Schema>;
export const AgentsAcpBackendsDeleteOutputV1Schema = lazyZodSchema(() => z.object({
  backendId: z.string(),
  deleted: z.literal(true),
  cleanup: AcpCatalogCleanupV1Schema.optional(),
}).strict());
