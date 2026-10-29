import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ArtifactSavedByV1Schema } from '../../artifacts/artifactBinaryV1.js';
import { PromptDocRevisionV1Schema, PromptDocCreateActionInputV1Schema } from '../../prompts/library/promptDocV2.js';
import { PromptBundleUpdateActionInputV1Schema } from '../../prompts/library/promptBundleSchemas.js';
import { PromptLibrarySaveOrganizationFieldsV1, isPromptLibrarySaveFolderAssignmentV1 } from '../../prompts/library/promptFolderActionSchemasV1.js';
import { PromptLibraryStackUpdateInputV1Schema, PromptLibraryStackUpdateResultV1Schema } from '../../prompts/library/promptStacksV1.js';
import { readRecord } from '../../inputs/inputRecords.js';
import { z } from 'zod/mini';
import { PromptAssetInstallModeV1Schema, PromptAssetScopeV1Schema } from '../../prompts/library/promptAssetsV1.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import type { PreNormalizedActionSpec } from './definition.js';


/**
 * The Prompt Library invocation inventory read.
 *
 * It returns the invocation entries themselves — stable `id`, user-facing
 * `token`, title, behavior — and never a prompt body: an inventory that
 * expanded every referenced document would fetch every artifact in the Library
 * to answer "which prompts exist".
 */
export const PromptInvocationsListInputSchema = lazyZodSchema(() => z.looseObject({
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(500))),
}));

/**
 * Resolve ONE Prompt Library invocation to the text it produces.
 *
 * `invocationId` is the entry's stable id, never the renameable slash token:
 * renaming a command must not break a stored reference to it. Rendering the
 * body is the Library's own job, so this is a projection of the incumbent
 * expansion owner rather than a second template renderer.
 */
export const PromptInvocationResolveInputSchema = lazyZodSchema(() => z.looseObject({
  invocationId: z.string().check(z.minLength(1)),
  argsText: z.optional(z.string()),
}));

export const PromptDocUpdateInputSchema = lazyZodSchema(() => z.strictObject({
  artifactId: z.string().check(z.minLength(1)),
  title: z.string().check(z.minLength(1)),
  markdown: z.string(),
  expectedRevision: z.optional(PromptDocRevisionV1Schema),
  ...PromptLibrarySaveOrganizationFieldsV1,
}).check(z.refine(isPromptLibrarySaveFolderAssignmentV1, { message: 'Folder assignment must match the reviewed folder creation' })));

export const PromptRegistryInstallCanonicalInputSchema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.minLength(1)),
  sourceId: z.string().check(z.minLength(1)),
  itemId: z.string().check(z.minLength(1)),
  installTarget: z.optional(z.strictObject({
    assetTypeId: z.string().check(z.minLength(1)),
    scope: PromptAssetScopeV1Schema,
    directory: z.optional(z.string().check(z.minLength(1))),
    targetName: z.string().check(z.minLength(1)),
    installMode: z.optional(PromptAssetInstallModeV1Schema),
  })),
}));

export const PromptRegistryInstallInputSchema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((raw: z.input<typeof PromptRegistryInstallCanonicalInputSchema>) => {
  // Released 0.2 stored inputs carried source declarations; current authority is the Account row.
  const { configuredSources: _legacyDeclarations, installTarget: _legacyNativeTarget, ...input } = readRecord(raw);
  return input;
}), PromptRegistryInstallCanonicalInputSchema));

export const PROMPT_DOCUMENT_ACTION_SPECS = Object.freeze([
  {
    id: 'prompt_doc.get', executionPlacement: 'account', approval: {result: 'required'},
    title: 'Read prompt document',
    description: 'Read the current prompt document and its observed Artifact revision.',
    safety: 'safe',
    sideEffectClass: 'read',
    placements: [],
    bindings: { mcpToolName: 'prompt_doc_get', voiceClientToolName: 'getPromptDoc' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: lazyZodSchema(() => z.strictObject({ artifactId: z.string().check(z.minLength(1)) })),
    outputSchema: lazyZodSchema(() => z.strictObject({ ok: z.literal(true), artifactId: z.string().check(z.minLength(1)), title: z.string().check(z.minLength(1)), markdown: z.string(),
      revision: PromptDocRevisionV1Schema, provenance: z.optional(z.strictObject({ savedBy: ArtifactSavedByV1Schema })) })),
    inputHints: { title: 'Read prompt document', fields: [
      { path: 'artifactId', title: 'Prompt artifact id', widget: 'text', required: true },
    ] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'prompt_doc.create', executionPlacement: 'account', approval: {result: 'none'},
    approvalPolicy: { uiConfirmation: 'direct' },
    title: 'Create prompt document',
    description: 'Create an Account-private prompt document in the Happier prompt library.',
    safety: 'danger',
    sideEffectClass: 'danger',
    placements: [],
    bindings: { mcpToolName: 'prompt_doc_create', voiceClientToolName: 'createPromptDoc' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: PromptDocCreateActionInputV1Schema,
    outputSchema: lazyZodSchema(() => z.strictObject({ ok: z.literal(true), artifactId: z.string().check(z.minLength(1)) })),
    inputHints: { title: 'Create prompt document', fields: [
      { path: 'starter', title: 'Built-in starter', widget: 'text',
        visibleWhen: { op: 'eq', path: 'starter', value: 'happier_guide' } },
      { path: 'title', title: 'Title', widget: 'text', required: true,
        visibleWhen: { op: 'not', predicate: { op: 'eq', path: 'starter', value: 'happier_guide' } } },
      { path: 'markdown', title: 'Markdown', widget: 'textarea', required: true,
        visibleWhen: { op: 'not', predicate: { op: 'eq', path: 'starter', value: 'happier_guide' } } },
      { path: 'folderId', title: 'Folder id', widget: 'text' },
      { path: 'tags', title: 'Tags', widget: 'text_list', listSeparator: 'comma' },
      { path: 'favorite', title: 'Favourite', widget: 'boolean' },
      { path: 'createFolder', title: 'New folder', widget: 'json' },
    ] },
  } satisfies PreNormalizedActionSpec,
] as const);


export const PROMPT_INVOCATION_ACTION_SPECS = Object.freeze([
  {
    id: 'prompts.invocations.list', executionPlacement: 'account', approval: {result: 'required'},
    title: 'List prompt invocations',
    sideEffectClass: 'read',
    description:
      "List the account's Prompt Library invocations by stable id, without expanding any prompt body.",
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'prompts_invocations_list' },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'List prompt invocations',
      fields: [
        { path: 'limit', title: 'Limit', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: PromptInvocationsListInputSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'prompts.invocation.resolve', executionPlacement: 'account', approval: {result: 'required'},
    title: 'Resolve a prompt invocation',
    sideEffectClass: 'read',
    description:
      'Resolve one Prompt Library invocation, by its stable id, to the prompt text it produces.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'prompts_invocation_resolve' },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    inputHints: {
      title: 'Resolve a prompt invocation',
      fields: [
        { path: 'invocationId', title: 'Invocation id', widget: 'text', required: true },
        { path: 'argsText', title: 'Arguments', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: PromptInvocationResolveInputSchema,
  } satisfies PreNormalizedActionSpec,
] as const);


export const PROMPT_LIBRARY_ACTION_SPECS = Object.freeze([
  {
    id: 'prompt_doc.favorite.set', executionPlacement: 'account', approval: {result: 'none'},
    title: 'Set prompt favourite',
    description: 'Set a prompt document favourite without changing its content.',
    safety: 'safe',
    sideEffectClass: 'write',
    placements: [],
    bindings: { mcpToolName: 'prompt_doc_favorite_set', voiceClientToolName: 'setPromptDocFavorite' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: lazyZodSchema(() => z.strictObject({ artifactId: z.string().check(z.minLength(1)), favorite: z.boolean() })),
    outputSchema: lazyZodSchema(() => z.strictObject({ ok: z.literal(true), artifactId: z.string().check(z.minLength(1)) })),
    inputHints: { title: 'Set prompt favourite', fields: [
      { path: 'artifactId', title: 'Prompt artifact id', widget: 'text', required: true },
      { path: 'favorite', title: 'Favourite', widget: 'boolean', required: true },
    ] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'prompts.library.list', executionPlacement: 'account', approval: {result: 'required'},
    title: 'List prompt library',
    description: 'List prompt document headers without fetching their bodies.',
    safety: 'safe',
    sideEffectClass: 'read',
    placements: [],
    bindings: { mcpToolName: 'prompts_library_list', voiceClientToolName: 'listPromptLibrary' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: lazyZodSchema(() => z.strictObject({ query: z.optional(z.string()) })),
    outputSchema: lazyZodSchema(() => z.strictObject({ coverage: z.enum(['complete', 'partial', 'unavailable']), items: z.array(z.strictObject({
      artifactId: z.string().check(z.minLength(1)), title: z.string(), folderId: z.nullable(z.string()), tags: z.array(z.string()),
      favorite: z.boolean(), updatedAtMs: z.number(),
    })) })),
    inputHints: { title: 'List prompt library', fields: [{ path: 'query', title: 'Search', widget: 'text' }] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'prompts.stack.update', approval: {result: 'required'}, title: 'Update account instructions', safety: 'safe', sideEffectClass: 'write',
    requiredAuthority: 'account_automation', executionPlacement: 'account', placements: [],
    bindings: { mcpToolName: 'prompts_stack_update', rpcMethod: 'prompts.stack.update' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: true },
    inputSchema: PromptLibraryStackUpdateInputV1Schema, outputSchema: PromptLibraryStackUpdateResultV1Schema,
    // The private review names the exact semantic edit; shared observations
    // intentionally retain only the stack surface and its revision.
    approvalPresentation: { summary: () => null, projectInput: (input: unknown) => PromptLibraryStackUpdateInputV1Schema.parse(input) },
    projectObservationInput: (input: unknown) => { const value = readRecord(input); return { surface: value.surface, expectedRevision: value.expectedRevision }; },
    projectObservationOutput: (output: unknown) => { const value = readRecord(output); return { status: value.status,
      ...(value.revision === undefined ? {} : { revision: value.revision }) }; },
    inputHints: { description: 'Change the instructions and context every session in your account starts with.', fields: [] },
    cli: { acceptsServerId: true, commands: [{ path: ['prompts', 'stack', 'update'], visibility: 'canonical' }] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'prompt_doc.update', executionPlacement: 'account', approval: {result: 'none'},
    title: 'Update prompt document',
    description: 'Update a prompt document. Supply the reviewed Artifact revision to refuse changed content without rebasing the edit.',
    safety: 'danger',
    sideEffectClass: 'write',
    placements: [],
    bindings: { mcpToolName: 'prompt_doc_update', voiceClientToolName: 'updatePromptDoc' },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    outputSchema: z.strictObject({ ok: z.literal(true), artifactId: z.string(), revision: z.optional(PromptDocRevisionV1Schema) }),
    inputSchema: PromptDocUpdateInputSchema,
    inputHints: {
      title: 'Update prompt document',
      fields: [
        { path: 'artifactId', title: 'Prompt artifact id', widget: 'text', required: true },
        { path: 'title', title: 'Title', widget: 'text', required: true },
        { path: 'markdown', title: 'Markdown', widget: 'textarea', required: true },
        { path: 'expectedRevision.headerVersion', title: 'Reviewed header version', widget: 'text' },
        { path: 'expectedRevision.bodyVersion', title: 'Reviewed body version', widget: 'text' },
        { path: 'createFolder', title: 'New folder', widget: 'json' },
        { path: 'folderId', title: 'Folder id', widget: 'text' },
        { path: 'tags', title: 'Tags', widget: 'text_list', listSeparator: 'comma' },
      ],
    },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'prompt_bundle.update', executionPlacement: 'account', approval: {result: 'none'},
    title: 'Update prompt bundle',
    description: 'Update a skill bundle stored in the Happier prompt library.',
    safety: 'danger', sideEffectClass: 'write',
    placements: [],
    bindings: { mcpToolName: 'prompt_bundle_update', voiceClientToolName: 'updatePromptBundle' },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    outputSchema: lazyZodSchema(() => z.strictObject({ ok: z.literal(true), artifactId: z.string().check(z.minLength(1)), revision: z.optional(PromptDocRevisionV1Schema) })),
    inputSchema: PromptBundleUpdateActionInputV1Schema,
    inputHints: {
      title: 'Update prompt bundle',
      fields: [
        { path: 'artifactId', title: 'Bundle artifact id', widget: 'text', required: true },
        { path: 'title', title: 'Title', widget: 'text', required: true },
        { path: 'skillMarkdown', title: 'SKILL.md markdown', widget: 'textarea' },
        { path: 'entries', title: 'Files', widget: 'json' },
        { path: 'createFolder', title: 'New folder', widget: 'json' },
        { path: 'expectedRevision.headerVersion', title: 'Reviewed header version', widget: 'text' },
        { path: 'expectedRevision.bodyVersion', title: 'Reviewed body version', widget: 'text' },
        { path: 'folderId', title: 'Folder id', widget: 'text' },
        { path: 'tags', title: 'Tags', widget: 'text_list', listSeparator: 'comma' },
      ],
    },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'prompt_registry.install', executionPlacement: 'machine', approval: {result: 'optional',flow: 'deferred'},
    approvalPolicy: { uiConfirmation: 'direct' },
    sideEffectClass: 'external',
    title: 'Install prompt registry skill',
    description: 'Import a skill bundle from a registry into the Happier library.',
    safety: 'danger',
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: false,
      rpc: false,
      },
    outputSchema: StrictJsonValueSchema,
    inputSchema: PromptRegistryInstallInputSchema,
    inputHints: {
      title: 'Install prompt registry skill',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
        { path: 'sourceId', title: 'Source id', widget: 'text', required: true },
        { path: 'itemId', title: 'Item id', widget: 'text', required: true },
      ],
    },
  } satisfies PreNormalizedActionSpec,
] as const);

