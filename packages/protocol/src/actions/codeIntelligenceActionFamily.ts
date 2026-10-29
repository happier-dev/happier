export { CODE_INTELLIGENCE_ACTION_IDS } from './codeIntelligenceActionIdsV1.js';
import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { CodeIntelligenceFallbackResultSchema, isCodeIdentifier } from '../machines/codeIntelligenceFallback.js';
import { DaemonLspQueryRequestSchema, DaemonLspQueryResponseSchema, DaemonLspRestartRequestSchema, DaemonLspRestartResponseSchema, DaemonLspApplyRequestSchema, DaemonLspApplyResponseSchema, LanguageIntelligenceCodeActionOperationSchema, type DaemonLspQueryRequest } from '../machines/languageIntelligence.js';
import { WorkspaceFileEditSetFileSchema } from '../machines/workspaceFiles.js';
import { RPC_METHODS } from '../rpc/methods.js';
import type { ActionSpecSurfaceBindings, PreNormalizedActionSpec } from './actionSpecs.js';

export const CODE_INTELLIGENCE_QUERY_KIND_BY_ACTION_ID = {
  'code.hover.get': 'hover', 'code.definition.get': 'definition', 'code.references.list': 'references',
  'code.symbols.list': 'documentSymbols', 'code.diagnostics.list': 'diagnostics',
  'code.completion.list': 'completion', 'code.signature.get': 'signatureHelp',
  'code.typeDefinition.get': 'typeDefinition', 'code.implementation.get': 'implementation',
  'code.symbols.workspace': 'workspaceSymbol', 'code.callHierarchy.get': 'callHierarchy',
} as const satisfies Readonly<Record<string, DaemonLspQueryRequest['kind']>>;
const machineId = z.string().check(z.trim(), z.minLength(1));
export const CodeIntelligenceFileActionInputSchema = lazyZodSchema(() => z.strictObject({
  machineId,
  rootPath: DaemonLspQueryRequestSchema.shape.rootPath,
  path: DaemonLspQueryRequestSchema.shape.path,
  languageId: z.optional(z.string().check(z.minLength(1))),
}));
export const CodeIntelligenceActionInputSchema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.trim(), z.minLength(1)),
  rootPath: DaemonLspQueryRequestSchema.shape.rootPath,
  path: DaemonLspQueryRequestSchema.shape.path,
  line: z.number().check(z.int(), z.positive()),
  symbol: z.optional(z.string().check(z.refine(isCodeIdentifier))),
  occurrence: z.optional(z.number().check(z.int(), z.positive())),
  character: z.optional(z.number().check(z.int(), z.nonnegative())),
  languageId: z.optional(z.string().check(z.minLength(1))),
}));
export const CodeIntelligenceDiagnosticsInputSchema = lazyZodSchema(() => z.strictObject({
  ...CodeIntelligenceFileActionInputSchema.shape, scope: DaemonLspQueryRequestSchema.shape.scope,
}));
export const CodeIntelligenceWorkspaceSymbolsInputSchema = lazyZodSchema(() => z.strictObject({
  ...CodeIntelligenceFileActionInputSchema.shape, query: z.string(),
}));
export const CodeIntelligenceCallHierarchyInputSchema = lazyZodSchema(() => z.strictObject({
  ...CodeIntelligenceFileActionInputSchema.shape,
  line: z.optional(CodeIntelligenceActionInputSchema.shape.line),
  symbol: CodeIntelligenceActionInputSchema.shape.symbol, occurrence: CodeIntelligenceActionInputSchema.shape.occurrence,
  character: CodeIntelligenceActionInputSchema.shape.character,
  hierarchy: z.nonoptional(DaemonLspQueryRequestSchema.shape.hierarchy),
  serverId: DaemonLspQueryRequestSchema.shape.serverId,
}));
const reviewedEditOperationSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('apply'), files: z.array(WorkspaceFileEditSetFileSchema),
}));
export const CodeIntelligenceFormatInputSchema = lazyZodSchema(() => z.strictObject({
  ...CodeIntelligenceFileActionInputSchema.shape,
  operation: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('preview'), range: DaemonLspQueryRequestSchema.shape.range,
      formattingOptions: DaemonLspQueryRequestSchema.shape.formattingOptions }), reviewedEditOperationSchema,
  ]),
}));
export const CodeIntelligenceOrganizeImportsInputSchema = lazyZodSchema(() => z.strictObject({
  ...CodeIntelligenceFileActionInputSchema.shape,
  operation: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('preview') }), reviewedEditOperationSchema]),
}));
export const CodeIntelligenceRestartActionInputSchema = lazyZodSchema(() => z.strictObject({ machineId, ...DaemonLspRestartRequestSchema.shape }));
export const CodeIntelligenceRenamePreviewInputSchema = lazyZodSchema(() => z.strictObject({
  ...CodeIntelligenceActionInputSchema.shape, newName: z.optional(z.string().check(z.minLength(1))),
}));
export const CodeIntelligenceFileRenamePreviewInputSchema = lazyZodSchema(() => z.strictObject({
  ...CodeIntelligenceFileActionInputSchema.shape, newPath: DaemonLspQueryRequestSchema.shape.path,
}));
export const CodeIntelligenceEditApplyInputSchema = lazyZodSchema(() => z.strictObject({
  ...CodeIntelligenceFileActionInputSchema.shape, files: z.array(WorkspaceFileEditSetFileSchema),
}));
export const CodeIntelligenceCodeActionApplyInputSchema = lazyZodSchema(() => z.strictObject({
  ...CodeIntelligenceFileActionInputSchema.shape, operation: LanguageIntelligenceCodeActionOperationSchema,
}));
function queryOutput(kind: DaemonLspQueryRequest['kind']) {
  const semantic = DaemonLspQueryResponseSchema.check(z.superRefine((value, context) => {
    if (value.status === 'ok' && (value.kind !== kind || !value.fileHash)) {
      context.addIssue({ code: 'custom', message: 'An Action answer must match its query and include the disk content hash' });
    }
  }));
  return kind === 'definition' || kind === 'references' ? z.union([semantic, CodeIntelligenceFallbackResultSchema]) : semantic;
}
function semanticPreviewOutput(kinds: readonly string[]) {
  return DaemonLspQueryResponseSchema.check(z.superRefine((value, context) => {
    if (value.status === 'ok' && (!kinds.includes(value.kind) || !value.fileHash))
      context.addIssue({ code: 'custom', message: 'A semantic preview must include its disk hash and match the requested operation' });
  }));
}
function mutationRpcBinding(kind: 'rename' | 'fileRename' | 'codeAction' | 'format' | 'organizeImports'): NonNullable<ActionSpecSurfaceBindings['rpc']> {
  return {
    inputSchema: lazyZodSchema(() => DaemonLspApplyRequestSchema.check(z.refine(request => request.operation.kind === kind))),
    outputSchema: DaemonLspApplyResponseSchema,
    decodeInput(value, context) {
      const request = DaemonLspApplyRequestSchema.parse(value), target = context.externalActionTarget;
      if (target?.kind !== 'machine') throw new Error('An exact Machine target is required');
      if (request.operation.kind === 'codeAction') return { machineId: target.machineId, ...request };
      const fileTarget = { machineId: target.machineId, rootPath: request.rootPath, path: request.path,
        ...(request.languageId ? { languageId: request.languageId } : {}) };
      return request.operation.kind === 'format' || request.operation.kind === 'organizeImports'
        ? { ...fileTarget, operation: { kind: 'apply', files: request.operation.files } }
        : { ...fileTarget, files: request.operation.files };
    },
    encodeOutput: value => value,
  };
}
const shared = {
  approval: { result: 'required' }, safety: 'safe', sideEffectClass: 'read', placements: [],
  contextualDefaults: { machineId: 'current_session_machine', rootPath: 'current_session_root' },
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
  inputSchema: CodeIntelligenceActionInputSchema,
  inputHints: { fields: [
    { path: 'machineId', title: 'Machine id', widget: 'text', description: 'Defaults to the calling session Machine; required outside a session.' },
    { path: 'rootPath', title: 'Workspace root', widget: 'text', description: 'Defaults to the calling session workspace on that Machine; required for another Machine or outside a session.' },
    { path: 'path', title: 'Current file', widget: 'text', required: true },
    { path: 'line', title: 'Line (one-based)', widget: 'text', required: true },
    { path: 'symbol', title: 'Symbol name', widget: 'text', description: 'Symbol text, or supply an explicit zero-based UTF-16 character instead.' },
  ] },
} as const;
const fileFields = [...shared.inputHints.fields.slice(0, 3),
  { path: 'languageId', title: 'Language id', widget: 'text' as const }];
const editApplyInputHints = { fields: [...fileFields,
  { path: 'files', title: 'Reviewed file edits', widget: 'json' as const, required: true }] };
function editOperationSafety(input: unknown): 'safe' | 'danger' {
  return input !== null && typeof input === 'object' && 'operation' in input
    && input.operation !== null && typeof input.operation === 'object' && 'kind' in input.operation
    && input.operation.kind === 'preview' ? 'safe' : 'danger';
}
function editOperationOutput(kinds: readonly string[]) {
  return z.union([semanticPreviewOutput(kinds), DaemonLspApplyResponseSchema]);
}
const codeIntelligenceActionSpecs = [
  { ...shared, id: 'code.hover.get', title: 'Get symbol information', bindings: { mcpToolName: 'code_hover_get' }, outputSchema: lazyZodSchema(() => queryOutput('hover')),
    description: 'Read type and documentation for the symbol at a one-based line plus symbol text, or an explicit zero-based UTF-16 character. Answers concern disk text and include its content hash. Unsaved editor edits are refused; a loading project never becomes an empty answer.' },
  { ...shared, id: 'code.definition.get', title: 'Go to definition', bindings: { mcpToolName: 'code_definition_get' }, outputSchema: lazyZodSchema(() => queryOutput('definition')),
    description: 'Find the definition of a symbol by one-based line plus symbol text. Semantic answers concern disk text and include its hash. Without a capable server, explicit symbol names use approximate declaration search labeled text_matches.' },
  { ...shared, id: 'code.references.list', title: 'Find references', bindings: { mcpToolName: 'code_references_list' }, outputSchema: lazyZodSchema(() => queryOutput('references')),
    description: 'Find semantic references before changing a signature; address the symbol by one-based line plus name. Answers include the disk content hash. Without a capable server, explicit names use identifier text search labeled text_matches.' },
  { ...shared, id: 'code.symbols.list', title: 'List file symbols', bindings: { mcpToolName: 'code_symbols_list' },
    inputSchema: CodeIntelligenceFileActionInputSchema, inputHints: { fields: shared.inputHints.fields.slice(0, 3) }, outputSchema: lazyZodSchema(() => queryOutput('documentSymbols')),
    description: 'Read a file outline before opening a long file. Return current disk-text symbols and the content hash, or loading/unavailable; unsaved editor changes are refused.' },
  { ...shared, id: 'code.diagnostics.list', title: 'Check file problems', bindings: { mcpToolName: 'code_diagnostics_list' },
    inputSchema: CodeIntelligenceDiagnosticsInputSchema, inputHints: { fields: [...fileFields,
      { path: 'scope', title: 'Problems scope', widget: 'select', options: [{ value: 'document', label: 'Document' }, { value: 'project', label: 'Project' }] }] }, outputSchema: lazyZodSchema(() => queryOutput('diagnostics')),
    description: 'Check diagnostics after multi-file edits; scope project explicitly checks the whole project. Pull the current disk text and include its hash; return loading until the check succeeds, never an older stored list as fresh. Unsaved editor changes are refused.' },
  { ...shared, id: 'code.completion.list', title: 'List code completions', bindings: { mcpToolName: 'code_completion_list' },
    outputSchema: lazyZodSchema(() => queryOutput('completion')),
    description: 'Read language-server suggestions at a one-based line and symbol or zero-based UTF-16 character. Results include snippets and additional text edits such as imports; this read never applies them.' },
  { ...shared, id: 'code.signature.get', title: 'Get signature help', bindings: { mcpToolName: 'code_signature_get' },
    outputSchema: lazyZodSchema(() => queryOutput('signatureHelp')), description: 'Read call signatures and the active parameter at a one-based line and symbol or zero-based UTF-16 character.' },
  { ...shared, id: 'code.typeDefinition.get', title: 'Go to type definition', bindings: { mcpToolName: 'code_type_definition_get' },
    outputSchema: lazyZodSchema(() => queryOutput('typeDefinition')), description: 'Find semantic type definitions at a one-based line and symbol or zero-based UTF-16 character. Outside-workspace results do not widen file access.' },
  { ...shared, id: 'code.implementation.get', title: 'Go to implementation', bindings: { mcpToolName: 'code_implementation_get' },
    outputSchema: lazyZodSchema(() => queryOutput('implementation')), description: 'Find semantic implementations at a one-based line and symbol or zero-based UTF-16 character.' },
  { ...shared, id: 'code.symbols.workspace', title: 'Search project symbols', bindings: { mcpToolName: 'code_symbols_workspace' },
    inputSchema: CodeIntelligenceWorkspaceSymbolsInputSchema,
    inputHints: { fields: [...fileFields, { path: 'query', title: 'Symbol query', widget: 'text', required: true }] },
    outputSchema: lazyZodSchema(() => queryOutput('workspaceSymbol')), description: 'Search project-wide language-server symbols. The explicit file selects the workspace language servers; query is the symbol search text.' },
  { ...shared, id: 'code.callHierarchy.get', title: 'Explore call hierarchy', bindings: { mcpToolName: 'code_call_hierarchy_get' },
    inputSchema: CodeIntelligenceCallHierarchyInputSchema,
    inputHints: { fields: [...fileFields, { path: 'hierarchy', title: 'Call direction and item', widget: 'json', required: true },
      ...shared.inputHints.fields.slice(3).map(field => ({ ...field, required: false })), { path: 'serverId', title: 'Language-server id', widget: 'text' }] },
    outputSchema: lazyZodSchema(() => queryOutput('callHierarchy')), description: 'Read prepare/incoming/outgoing calls at a one-based line and symbol or UTF-16 character. Position-addressed incoming/outgoing calls prepare and query in one request, so they work without an open editor. While a document remains open, returned itemId plus serverId can address it instead; expired items are refused.' },
  { ...shared, id: 'code.format.apply', title: 'Format code', bindings: { mcpToolName: 'code_format_apply', rpcMethod: RPC_METHODS.DAEMON_LSP_FORMAT_APPLY },
    surfaces: { ...shared.surfaces, rpc: true }, surfaceBindings: { rpc: mutationRpcBinding('format') },
    safety: 'danger', safetyForInput: editOperationSafety, sideEffectClass: 'write', approvalPolicy: { uiConfirmation: 'direct' },
    inputSchema: CodeIntelligenceFormatInputSchema,
    inputHints: { fields: [...fileFields, { path: 'operation', title: 'Format preview or reviewed edits', widget: 'json', required: true }] },
    outputSchema: lazyZodSchema(() => editOperationOutput(['formatting', 'rangeFormatting'])),
    description: 'Preview document or selection formatting with operation kind preview (optional zero-based UTF-16 range and formattingOptions), then apply the reviewed files with operation kind apply. Uses the guarded writer and returns inverse edits for Undo.' },
  { ...shared, id: 'code.imports.organize', title: 'Organize imports', bindings: { mcpToolName: 'code_imports_organize', rpcMethod: RPC_METHODS.DAEMON_LSP_IMPORTS_ORGANIZE_APPLY },
    surfaces: { ...shared.surfaces, rpc: true }, surfaceBindings: { rpc: mutationRpcBinding('organizeImports') },
    safety: 'danger', safetyForInput: editOperationSafety, sideEffectClass: 'write', approvalPolicy: { uiConfirmation: 'direct' },
    inputSchema: CodeIntelligenceOrganizeImportsInputSchema,
    inputHints: { fields: [...fileFields, { path: 'operation', title: 'Import preview or reviewed edits', widget: 'json', required: true }] },
    outputSchema: lazyZodSchema(() => editOperationOutput(['organizeImports'])),
    description: 'Preview source.organizeImports edits with operation kind preview, then apply reviewed files with operation kind apply. Uses the same hash-guarded writer and Undo as semantic rename.' },
  { ...shared, id: 'code.restart', title: 'Restart language servers', sideEffectClass: 'write', bindings: { mcpToolName: 'code_restart' },
    inputSchema: CodeIntelligenceRestartActionInputSchema, inputHints: { fields: shared.inputHints.fields.slice(0, 2) }, outputSchema: DaemonLspRestartResponseSchema,
    description: 'Restart the host-owned language-server sessions for the addressed workspace, optionally one server definition. This reversible operation changes no workspace files; a root with no session is unavailable.' },
  { ...shared, id: 'code.rename.preview', title: 'Preview symbol rename', bindings: { mcpToolName: 'code_rename_preview' },
    inputSchema: CodeIntelligenceRenamePreviewInputSchema, outputSchema: lazyZodSchema(() => semanticPreviewOutput(['prepareRename', 'rename'])),
    description: 'Preview a semantic symbol rename as workspace-relative hash-guarded edits without writing. Omit newName to prepare the rename and inspect its target. Address by one-based line and symbol text.' },
  { ...shared, id: 'code.file.rename.preview', title: 'Preview file rename', bindings: { mcpToolName: 'code_file_rename_preview' },
    inputSchema: CodeIntelligenceFileRenamePreviewInputSchema,
    inputHints: { fields: [...fileFields, { path: 'newPath', title: 'New file path', widget: 'text', required: true }] },
    outputSchema: lazyZodSchema(() => semanticPreviewOutput(['willRenameFiles'])),
    description: 'Preview a file move with importer updates from the language server. Returns the guarded source move and importer edits; writes nothing.' },
  { ...shared, id: 'code.codeActions.list', title: 'List code actions', bindings: { mcpToolName: 'code_code_actions_list' },
    outputSchema: lazyZodSchema(() => semanticPreviewOutput(['codeActions'])), description: 'Read available server code actions at a symbol. Edits are normalized and hash-guarded; command execution requires the separate apply Action.' },
  { ...shared, id: 'code.rename.apply', title: 'Apply symbol rename', bindings: { mcpToolName: 'code_rename_apply', rpcMethod: RPC_METHODS.DAEMON_LSP_RENAME_APPLY }, surfaces: { ...shared.surfaces, rpc: true },
    surfaceBindings: { rpc: mutationRpcBinding('rename') },
    safety: 'danger', sideEffectClass: 'write', approvalPolicy: { uiConfirmation: 'direct' },
    inputSchema: CodeIntelligenceEditApplyInputSchema, inputHints: editApplyInputHints, outputSchema: DaemonLspApplyResponseSchema,
    description: 'Apply reviewed semantic rename edits through the guarded multi-file writer. Changed files are refused and successful files return inverse edits for Undo.' },
  { ...shared, id: 'code.file.rename.apply', title: 'Apply file rename', bindings: { mcpToolName: 'code_file_rename_apply', rpcMethod: RPC_METHODS.DAEMON_LSP_FILE_RENAME_APPLY }, surfaces: { ...shared.surfaces, rpc: true },
    surfaceBindings: { rpc: mutationRpcBinding('fileRename') },
    safety: 'danger', sideEffectClass: 'write', approvalPolicy: { uiConfirmation: 'direct' },
    inputSchema: CodeIntelligenceEditApplyInputSchema, inputHints: editApplyInputHints, outputSchema: DaemonLspApplyResponseSchema,
    description: 'Apply a reviewed file rename and importer updates through the guarded multi-file writer, retaining inverse edits and the reverse move for Undo.' },
  { ...shared, id: 'code.codeAction.apply', title: 'Apply code action', bindings: { mcpToolName: 'code_code_action_apply', rpcMethod: RPC_METHODS.DAEMON_LSP_CODE_ACTION_APPLY }, surfaces: { ...shared.surfaces, rpc: true },
    surfaceBindings: { rpc: mutationRpcBinding('codeAction') },
    safety: 'danger', sideEffectClass: 'write', approvalPolicy: { uiConfirmation: 'direct' },
    inputSchema: CodeIntelligenceCodeActionApplyInputSchema,
    inputHints: { fields: [...fileFields, { path: 'operation', title: 'Reviewed code action', widget: 'json', required: true }] },
    outputSchema: DaemonLspApplyResponseSchema,
    description: 'Apply one reviewed server code action, including a declared server command. Server edit requests share the guarded multi-file writer and retain partial results and Undo.' },
] as const satisfies readonly PreNormalizedActionSpec[];

export const CODE_INTELLIGENCE_ACTION_SPECS = codeIntelligenceActionSpecs.map(spec => ({
  ...spec,
  description: `${spec.description} Machine and root default to the calling session; supply both for another Machine or outside a session.`,
}));
