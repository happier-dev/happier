import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { WorkspaceFileEditSetFileSchema, WorkspaceFileEditPositionSchema, WorkspaceFileEditRangeSchema, DaemonWorkspaceFileReplaceApplyResponseSchema } from './workspaceFiles.js';
import { PluginJsonValueV2Schema } from '../plugins/contributions/publicTypes.js';
import { ProviderConnectionIdSchema, ProviderModelIdSchema } from '../providers/ids.js';

const nonempty = () => z.string().check(z.minLength(1));
const revision = () => z.number().check(z.int(), z.nonnegative());
const hash = () => z.string().check(z.regex(/^[a-f0-9]{64}$/u));

/** Native records drop __proto__; workspace paths must retain that valid name. */
function ownStringRecord<Value>(key: z.ZodMiniType<string, string>, value: z.ZodMiniType<Value>) {
  const entries = z.pipe(z.custom<Record<string, unknown>>(z.core.util.isPlainObject),
    z.transform((input) => new Map(Object.entries(input))));
  const schema = z.pipe(z.pipe(entries, z.map(key, value)), z.transform((items) => Object.fromEntries(items)));
  // The wire remains an ordinary object dictionary. Derive its projection
  // from the same native key/value schemas without executing the lossy parser.
  const projection = z.record(key, value);
  schema._zod.processJSONSchema = (_context, jsonSchema) => {
    Object.assign(jsonSchema, Object.fromEntries(Object.entries(z.toJSONSchema(projection))
      .filter(([keyword]) => keyword !== '$schema')));
  };
  return schema;
}

/** Machine wire paths are normalized workspace-relative paths, never LSP URIs. */
export const LanguageIntelligencePathSchema = lazyZodSchema(() => nonempty().check(z.refine((value) =>
  !value.includes('\0') && !value.includes('\\') && !value.startsWith('/') && !/^[a-z]:/iu.test(value)
  && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'), 'Expected a workspace-relative path')));

export const LanguageIntelligencePositionSchema = WorkspaceFileEditPositionSchema;
export type LanguageIntelligencePosition = z.infer<typeof LanguageIntelligencePositionSchema>;
export const LanguageIntelligenceRangeSchema = WorkspaceFileEditRangeSchema;
export type LanguageIntelligenceRange = z.infer<typeof LanguageIntelligenceRangeSchema>;

export const LanguageIntelligenceRecentEditSchema = lazyZodSchema(() => z.strictObject({
  baseVersion: revision(), version: revision(), range: LanguageIntelligenceRangeSchema, oldText: z.string(), newText: z.string(),
}).check(z.refine(edit => edit.version > edit.baseVersion, 'An edit advances the captured version')));
export type LanguageIntelligenceRecentEdit = z.infer<typeof LanguageIntelligenceRecentEditSchema>;
export const LanguageIntelligencePredictedEditSchema = lazyZodSchema(() => z.strictObject({
  path: LanguageIntelligencePathSchema, range: LanguageIntelligenceRangeSchema, oldText: z.string(), newText: z.string(),
}));
export type LanguageIntelligencePredictedEdit = z.infer<typeof LanguageIntelligencePredictedEditSchema>;
export const LanguageIntelligenceNextEditInputSchema = lazyZodSchema(() => z.strictObject({
  connectionId: ProviderConnectionIdSchema, modelId: ProviderModelIdSchema,
  document: z.string(), target: z.strictObject({ range: LanguageIntelligenceRangeSchema, text: z.string() }),
  recentEdits: z.array(LanguageIntelligenceRecentEditSchema),
}).check(z.refine(input => input.target.range.start.line === 0 && input.target.range.start.character === 0
  && input.target.text === input.document, 'The dedicated rewrite operation requires an explicit whole-file target')));
export type LanguageIntelligenceNextEditInput = z.infer<typeof LanguageIntelligenceNextEditInputSchema>;
export { validateLanguageIntelligenceNextEdit, validateLanguageIntelligenceNextEditInput,
  encodeNextEditRewriteWindow, decodeNextEditRewriteWindow, diffLanguageIntelligenceText } from './languageIntelligenceNextEdit.js';

export const LanguageIntelligenceCapabilitiesSchema = lazyZodSchema(() => z.strictObject({
  hover: z.boolean(), definition: z.boolean(), references: z.boolean(), documentSymbol: z.boolean(),
  diagnostics: z.enum(['pull', 'push', 'none']), acceptsExternalChanges: z.boolean(),
  rename: z.optional(z.boolean()), prepareRename: z.optional(z.boolean()), fileRename: z.optional(z.boolean()), codeAction: z.optional(z.boolean()),
  completion: z.optional(z.boolean()), completionResolve: z.optional(z.boolean()), signatureHelp: z.optional(z.boolean()),
  formatting: z.optional(z.boolean()), rangeFormatting: z.optional(z.boolean()), organizeImports: z.optional(z.boolean()),
  typeDefinition: z.optional(z.boolean()), implementation: z.optional(z.boolean()), documentHighlight: z.optional(z.boolean()),
  selectionRange: z.optional(z.boolean()), inlayHint: z.optional(z.boolean()), semanticTokensRange: z.optional(z.boolean()), semanticTokensDelta: z.optional(z.boolean()),
  callHierarchy: z.optional(z.boolean()), workspaceSymbol: z.optional(z.boolean()), workspaceDiagnostics: z.optional(z.boolean()),
  completionTriggerCharacters: z.optional(z.array(z.string())), signatureTriggerCharacters: z.optional(z.array(z.string())), signatureRetriggerCharacters: z.optional(z.array(z.string())),
}));
export type LanguageIntelligenceCapabilities = z.infer<typeof LanguageIntelligenceCapabilitiesSchema>;

export const LanguageIntelligenceUnavailableReasonSchema = lazyZodSchema(() => z.enum([
  'no_capable_server', 'server_missing', 'start_failed', 'unsupported_root', 'session_unavailable', 'crashed',
  'method_unavailable', 'update_required', 'transport_failed', 'invalid_response',
]));
export type LanguageIntelligenceUnavailableReason = z.infer<typeof LanguageIntelligenceUnavailableReasonSchema>;
export const LanguageIntelligenceServerStatusSchema = lazyZodSchema(() => z.strictObject({
  serverId: nonempty(), label: nonempty(), state: z.enum(['idle', 'starting', 'ready', 'restarting', 'stopped', 'crashed', 'unavailable']),
  loading: z.boolean(), generation: nonempty(), reason: z.optional(LanguageIntelligenceUnavailableReasonSchema),
  installable: z.optional(z.strictObject({ pluginId: nonempty(), dependencyId: nonempty() })),
  stderrPreview: z.optional(z.string()),
  capabilities: z.optional(LanguageIntelligenceCapabilitiesSchema),
}));
export type LanguageIntelligenceServerStatus = z.infer<typeof LanguageIntelligenceServerStatusSchema>;
export type LanguageIntelligenceServerState = LanguageIntelligenceServerStatus['state'];

export const LanguageIntelligenceDiagnosticSchema = lazyZodSchema(() => z.strictObject({
  serverId: nonempty(), path: LanguageIntelligencePathSchema, range: LanguageIntelligenceRangeSchema,
  severity: z.enum(['error', 'warning', 'information', 'hint']), message: z.string(),
  code: z.optional(z.union([z.string(), z.number()])), source: z.optional(z.string()),
}));
export type LanguageIntelligenceDiagnostic = z.infer<typeof LanguageIntelligenceDiagnosticSchema>;

export type LanguageIntelligenceDocumentSymbol = {
  serverId: string; name: string; kind: number; range: LanguageIntelligenceRange; selectionRange: LanguageIntelligenceRange;
  children?: LanguageIntelligenceDocumentSymbol[];
};
export const LanguageIntelligenceDocumentSymbolSchema: z.ZodMiniType<LanguageIntelligenceDocumentSymbol> = z.lazy(() => z.strictObject({
  serverId: nonempty(), name: z.string(), kind: z.number().check(z.int(), z.positive()),
  range: LanguageIntelligenceRangeSchema, selectionRange: LanguageIntelligenceRangeSchema,
  children: z.optional(z.array(LanguageIntelligenceDocumentSymbolSchema)),
}));

const generalErrorCodes = [
  'session_unavailable', 'cancelled', 'document_out_of_sync', 'stale_query', 'request_failed', 'unsupported',
  'invalid_position', 'invalid_request', 'path_not_allowed', 'root_not_found',
  'ai_disabled', 'ai_excluded', 'ai_language_disabled', 'model_unavailable', 'signed_out', 'rate_limited',
] as const;
export const LanguageIntelligenceErrorCodeSchema = lazyZodSchema(() => z.enum([
  ...generalErrorCodes, 'unsaved_editor_changes', 'symbol_not_found',
]));
export type LanguageIntelligenceErrorCode = z.infer<typeof LanguageIntelligenceErrorCodeSchema>;
const failureSchema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('loading') }),
  z.strictObject({ status: z.literal('unavailable'), reason: LanguageIntelligenceUnavailableReasonSchema }),
  z.strictObject({ status: z.literal('error'), errorCode: z.enum(generalErrorCodes) }),
  z.strictObject({ status: z.literal('error'), errorCode: z.literal('unsaved_editor_changes'), diskHash: hash() }),
  z.strictObject({ status: z.literal('error'), errorCode: z.literal('symbol_not_found'), candidates: z.array(z.string()) }),
]));

export const LanguageIntelligenceEditSchema = lazyZodSchema(() => z.strictObject({
  startLine: revision(), startCharacter: revision(), endLine: revision(), endCharacter: revision(), text: z.string(),
}).check(z.refine((edit) => edit.endLine > edit.startLine || (edit.endLine === edit.startLine && edit.endCharacter >= edit.startCharacter), 'Edit ends before its start')));
export type LanguageIntelligenceEdit = z.infer<typeof LanguageIntelligenceEditSchema>;
export const DaemonLspSyncRequestSchema = lazyZodSchema(() => z.strictObject({
  rootPath: nonempty(), op: z.discriminatedUnion('op', [
    z.strictObject({ op: z.enum(['open', 'snapshot']), path: LanguageIntelligencePathSchema,
      languageId: nonempty(), version: revision(), text: z.string(), unsaved: z.boolean() }),
    z.strictObject({ op: z.literal('change'), path: LanguageIntelligencePathSchema, version: revision(), baseVersion: revision(),
      edit: LanguageIntelligenceEditSchema, unsaved: z.boolean() }),
    z.strictObject({ op: z.literal('close'), path: LanguageIntelligencePathSchema }),
    z.strictObject({ op: z.literal('external'), paths: z.array(LanguageIntelligencePathSchema) }),
  ]),
}));
export type DaemonLspSyncRequest = z.infer<typeof DaemonLspSyncRequestSchema>;
export const DaemonLspSyncResponseSchema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('ok'), generation: nonempty(), version: z.optional(revision()),
    servers: z.array(LanguageIntelligenceServerStatusSchema), capabilities: z.optional(LanguageIntelligenceCapabilitiesSchema) }),
  failureSchema,
]));
export type DaemonLspSyncResponse = z.infer<typeof DaemonLspSyncResponseSchema>;

export const LanguageIntelligenceQueryPositionSchema = lazyZodSchema(() => z.union([
  LanguageIntelligencePositionSchema,
  z.strictObject({ line: revision(), symbol: nonempty(), occurrence: z.optional(z.number().check(z.int(), z.positive())) }),
]));
export const DaemonLspQueryRequestSchema = lazyZodSchema(() => z.strictObject({
  rootPath: nonempty(), path: LanguageIntelligencePathSchema,
  kind: z.enum(['hover', 'definition', 'references', 'documentSymbols', 'diagnostics', 'prepareRename', 'rename', 'willRenameFiles', 'codeActions',
    'completion', 'completionResolve', 'signatureHelp', 'formatting', 'rangeFormatting', 'organizeImports', 'typeDefinition', 'implementation',
    'documentHighlight', 'selectionRange', 'inlayHint', 'semanticTokens', 'callHierarchy', 'workspaceSymbol', 'ai.inlineSuggest', 'ai.nextEdit']),
  version: z.optional(revision()), generation: z.optional(nonempty()), position: z.optional(LanguageIntelligenceQueryPositionSchema),
  includeDeclaration: z.optional(z.boolean()), text: z.optional(z.enum(['held', 'disk'])),
  serverId: z.optional(nonempty()), languageId: z.optional(nonempty()),
  newName: z.optional(nonempty()), newPath: z.optional(LanguageIntelligencePathSchema), range: z.optional(LanguageIntelligenceRangeSchema),
  scope: z.optional(z.enum(['document', 'project'])), query: z.optional(z.string()), itemId: z.optional(nonempty()), previousResultId: z.optional(nonempty()),
  hierarchy: z.optional(z.strictObject({ direction: z.enum(['prepare', 'incoming', 'outgoing']), itemId: z.optional(nonempty()) })),
  completionContext: z.optional(z.strictObject({ triggerKind: z.union([z.literal(1), z.literal(2), z.literal(3)]), triggerCharacter: z.optional(z.string()) })),
  signatureContext: z.optional(z.strictObject({ triggerKind: z.union([z.literal(1), z.literal(2), z.literal(3)]), triggerCharacter: z.optional(z.string()), isRetrigger: z.boolean() })),
  formattingOptions: z.optional(z.strictObject({ tabSize: z.number().check(z.int(), z.positive()), insertSpaces: z.boolean(),
    trimTrailingWhitespace: z.optional(z.boolean()), insertFinalNewline: z.optional(z.boolean()), trimFinalNewlines: z.optional(z.boolean()) })),
  inlineSuggestion: z.optional(z.strictObject({ connectionId: ProviderConnectionIdSchema, modelId: ProviderModelIdSchema, prefix: z.string(), suffix: z.string() })),
  nextEdit: z.optional(LanguageIntelligenceNextEditInputSchema),
}).check(z.refine(request => request.kind === 'ai.inlineSuggest'
  ? request.inlineSuggestion !== undefined && request.version !== undefined && request.languageId !== undefined
    && request.position !== undefined && 'character' in request.position && request.nextEdit === undefined
  : request.kind === 'ai.nextEdit'
    ? request.nextEdit !== undefined && request.version !== undefined && request.languageId !== undefined
      && request.position !== undefined && 'character' in request.position && request.inlineSuggestion === undefined
    : request.inlineSuggestion === undefined && request.nextEdit === undefined, 'AI suggestions require captured buffer context')));
export type DaemonLspQueryRequest = z.infer<typeof DaemonLspQueryRequestSchema>;
const queryProvenance = { status: z.literal('ok'), fileHash: z.optional(hash()), version: z.optional(revision()), generation: z.optional(nonempty()) };
const definitionLocationSchema = lazyZodSchema(() => z.strictObject({
  serverId: nonempty(), path: nonempty(), outsideWorkspace: z.optional(z.boolean()), range: LanguageIntelligenceRangeSchema,
}).check(z.refine((value) => value.outsideWorkspace === true
  ? !value.path.includes('\0') && /^(?:\/|[a-z]:[\\/]|\\\\)/iu.test(value.path)
  : LanguageIntelligencePathSchema.safeParse(value.path).success, 'Definition target must match its workspace authority')));
export const LanguageIntelligenceCommandSchema = lazyZodSchema(() => z.strictObject({
  command: nonempty(), arguments: z.optional(z.array(PluginJsonValueV2Schema)),
}));
export const LanguageIntelligenceCodeActionSchema = lazyZodSchema(() => z.strictObject({
  serverId: nonempty(), title: nonempty(), kind: z.optional(z.string()),
  range: LanguageIntelligenceRangeSchema,
  files: z.array(WorkspaceFileEditSetFileSchema), hasCommand: z.boolean(),
  disabledReason: z.optional(z.string()),
}));
export type LanguageIntelligenceCodeAction = z.infer<typeof LanguageIntelligenceCodeActionSchema>;

export const LanguageIntelligenceTextEditSchema = lazyZodSchema(() => z.strictObject({ range: LanguageIntelligenceRangeSchema, newText: z.string() }));
export type LanguageIntelligenceTextEdit = z.infer<typeof LanguageIntelligenceTextEditSchema>;
/** Native completion/call data stays Machine-side; itemId addresses only the captured document generation. */
export const LanguageIntelligenceCompletionItemSchema = lazyZodSchema(() => z.strictObject({
  serverId: nonempty(), itemId: nonempty(), label: z.string(), kind: z.optional(revision()), detail: z.optional(z.string()), documentation: z.optional(z.string()),
  insertText: z.optional(z.string()), insertTextFormat: z.optional(z.union([z.literal(1), z.literal(2)])),
  textEdit: z.optional(z.union([LanguageIntelligenceTextEditSchema, z.strictObject({ insert: LanguageIntelligenceRangeSchema, replace: LanguageIntelligenceRangeSchema, newText: z.string() })])),
  additionalTextEdits: z.optional(z.array(LanguageIntelligenceTextEditSchema)), sortText: z.optional(z.string()), filterText: z.optional(z.string()),
  preselect: z.optional(z.boolean()), commitCharacters: z.optional(z.array(z.string())),
}));
export type LanguageIntelligenceCompletionItem = z.infer<typeof LanguageIntelligenceCompletionItemSchema>;
export const LanguageIntelligenceSignatureHelpSchema = lazyZodSchema(() => z.strictObject({
  signatures: z.array(z.strictObject({ label: z.string(), documentation: z.optional(z.string()), activeParameter: z.optional(revision()),
    parameters: z.optional(z.array(z.strictObject({ label: z.union([z.string(), z.tuple([revision(), revision()])]), documentation: z.optional(z.string()) }))) })),
  activeSignature: z.optional(revision()), activeParameter: z.optional(revision()),
}));
export type LanguageIntelligenceSignatureHelp = z.infer<typeof LanguageIntelligenceSignatureHelpSchema>;
export const LanguageIntelligenceCallHierarchyItemSchema = lazyZodSchema(() => z.strictObject({
  serverId: nonempty(), itemId: nonempty(), name: z.string(), kind: revision(), detail: z.optional(z.string()),
  path: nonempty(), outsideWorkspace: z.optional(z.boolean()), range: LanguageIntelligenceRangeSchema, selectionRange: LanguageIntelligenceRangeSchema,
}).check(z.refine(value => definitionLocationSchema.safeParse({ serverId: value.serverId, path: value.path, range: value.range,
  ...(value.outsideWorkspace ? { outsideWorkspace: true } : {}) }).success, 'Invalid call hierarchy target')));
export type LanguageIntelligenceCallHierarchyItem = z.infer<typeof LanguageIntelligenceCallHierarchyItemSchema>;
export const LanguageIntelligenceInlayHintSchema = lazyZodSchema(() => z.strictObject({
  serverId: nonempty(), position: LanguageIntelligencePositionSchema, label: z.string(), kind: z.optional(z.union([z.literal(1), z.literal(2)])),
  tooltip: z.optional(z.string()), paddingLeft: z.optional(z.boolean()), paddingRight: z.optional(z.boolean()), textEdits: z.optional(z.array(LanguageIntelligenceTextEditSchema)),
}));
export type LanguageIntelligenceInlayHint = z.infer<typeof LanguageIntelligenceInlayHintSchema>;
export const LanguageIntelligenceSemanticTokensSchema = lazyZodSchema(() => z.strictObject({
  serverId: nonempty(), legend: z.strictObject({ tokenTypes: z.array(z.string()), tokenModifiers: z.array(z.string()) }), resultId: z.optional(z.string()),
  data: z.optional(z.array(revision())), edits: z.optional(z.array(z.strictObject({ start: revision(), deleteCount: revision(), data: z.optional(z.array(revision())) }))),
}));
export type LanguageIntelligenceSemanticTokens = z.infer<typeof LanguageIntelligenceSemanticTokensSchema>;
export const DaemonLspQueryResponseSchema = lazyZodSchema(() => z.union([
  z.discriminatedUnion('kind', [
    z.strictObject({ ...queryProvenance, kind: z.literal('ai.nextEdit'), version: revision(),
      edits: z.array(LanguageIntelligencePredictedEditSchema), usage: z.optional(z.strictObject({
        inputTokens: z.optional(revision()), outputTokens: z.optional(revision()), costUsd: z.optional(z.number().check(z.nonnegative())),
      })) }),
    z.strictObject({ ...queryProvenance, kind: z.literal('ai.inlineSuggest'), text: z.string(), usage: z.optional(z.strictObject({
      inputTokens: z.optional(revision()), outputTokens: z.optional(revision()), costUsd: z.optional(z.number().check(z.nonnegative())),
    })) }),
    z.strictObject({ ...queryProvenance, kind: z.literal('hover'), sections: z.array(z.strictObject({
      serverId: nonempty(), label: nonempty(), markdown: z.string(), range: z.optional(LanguageIntelligenceRangeSchema),
    })) }),
    z.strictObject({ ...queryProvenance, kind: z.literal('definition'), locations: z.array(definitionLocationSchema), hasMore: z.boolean() }),
    z.strictObject({ ...queryProvenance, kind: z.enum(['typeDefinition', 'implementation']), locations: z.array(definitionLocationSchema), hasMore: z.boolean() }),
    z.strictObject({ ...queryProvenance, kind: z.literal('completion'), items: z.array(LanguageIntelligenceCompletionItemSchema), isIncomplete: z.boolean() }),
    z.strictObject({ ...queryProvenance, kind: z.literal('completionResolve'), item: LanguageIntelligenceCompletionItemSchema }),
    z.strictObject({ ...queryProvenance, kind: z.literal('signatureHelp'), help: z.nullable(LanguageIntelligenceSignatureHelpSchema) }),
    z.strictObject({ ...queryProvenance, kind: z.enum(['formatting', 'rangeFormatting', 'organizeImports']), files: z.array(WorkspaceFileEditSetFileSchema) }),
    z.strictObject({ ...queryProvenance, kind: z.literal('documentHighlight'), highlights: z.array(z.strictObject({ serverId: nonempty(), range: LanguageIntelligenceRangeSchema, kind: z.optional(z.union([z.literal(1), z.literal(2), z.literal(3)])) })) }),
    z.strictObject({ ...queryProvenance, kind: z.literal('selectionRange'), ranges: z.array(z.strictObject({ serverId: nonempty(), ranges: z.array(LanguageIntelligenceRangeSchema) })) }),
    z.strictObject({ ...queryProvenance, kind: z.literal('inlayHint'), hints: z.array(LanguageIntelligenceInlayHintSchema) }),
    z.strictObject({ ...queryProvenance, kind: z.literal('semanticTokens'), tokens: z.array(LanguageIntelligenceSemanticTokensSchema) }),
    z.strictObject({ ...queryProvenance, kind: z.literal('callHierarchy'), direction: z.enum(['prepare', 'incoming', 'outgoing']), items: z.array(LanguageIntelligenceCallHierarchyItemSchema), calls: z.array(z.strictObject({ item: LanguageIntelligenceCallHierarchyItemSchema, ranges: z.array(LanguageIntelligenceRangeSchema) })) }),
    z.strictObject({ ...queryProvenance, kind: z.literal('workspaceSymbol'), symbols: z.array(z.strictObject({ serverId: nonempty(), path: nonempty(), outsideWorkspace: z.optional(z.boolean()), range: LanguageIntelligenceRangeSchema, name: z.string(), kind: revision(), containerName: z.optional(z.string()) }).check(z.refine(value => definitionLocationSchema.safeParse({ serverId: value.serverId, path: value.path, range: value.range, ...(value.outsideWorkspace ? { outsideWorkspace: true } : {}) }).success, 'Invalid workspace symbol target'))), hasMore: z.boolean() }),
    z.strictObject({ ...queryProvenance, kind: z.literal('references'), locations: z.array(z.strictObject({
      serverId: nonempty(), path: LanguageIntelligencePathSchema, range: LanguageIntelligenceRangeSchema, lineText: z.string(),
    })), hasMore: z.boolean() }),
    z.strictObject({ ...queryProvenance, kind: z.literal('documentSymbols'), symbols: z.array(LanguageIntelligenceDocumentSymbolSchema), hasMore: z.boolean() }),
    z.strictObject({ ...queryProvenance, kind: z.literal('diagnostics'), diagnostics: z.array(LanguageIntelligenceDiagnosticSchema), hasMore: z.boolean() }),
    z.strictObject({ ...queryProvenance, kind: z.literal('prepareRename'), targets: z.array(z.strictObject({
      serverId: nonempty(), range: z.optional(LanguageIntelligenceRangeSchema), placeholder: z.optional(z.string()),
    })) }),
    z.strictObject({ ...queryProvenance, kind: z.enum(['rename', 'willRenameFiles']), files: z.array(WorkspaceFileEditSetFileSchema) }),
    z.strictObject({ ...queryProvenance, kind: z.literal('codeActions'), actions: z.array(LanguageIntelligenceCodeActionSchema) }),
  ]), failureSchema,
]));
export type DaemonLspQueryResponse = z.infer<typeof DaemonLspQueryResponseSchema>;

/** Mutation envelopes are closed; preview queries never acquire write authority. */
export const LanguageIntelligenceCodeActionOperationSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('codeAction'), action: LanguageIntelligenceCodeActionSchema, expectedHash: hash(),
}));
export const DaemonLspApplyRequestSchema = lazyZodSchema(() => z.strictObject({
  rootPath: nonempty(), path: LanguageIntelligencePathSchema, languageId: z.optional(nonempty()),
  operation: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('rename'), files: z.array(WorkspaceFileEditSetFileSchema) }),
    z.strictObject({ kind: z.literal('fileRename'), files: z.array(WorkspaceFileEditSetFileSchema) }),
    z.strictObject({ kind: z.enum(['format', 'organizeImports']), files: z.array(WorkspaceFileEditSetFileSchema) }),
    LanguageIntelligenceCodeActionOperationSchema,
  ]),
}));
export type DaemonLspApplyRequest = z.infer<typeof DaemonLspApplyRequestSchema>;
export const DaemonLspApplyResponseSchema = lazyZodSchema(() => z.union([DaemonWorkspaceFileReplaceApplyResponseSchema, failureSchema]));
export type DaemonLspApplyResponse = z.infer<typeof DaemonLspApplyResponseSchema>;

export const LanguageIntelligenceDiagnosticsEntrySchema = lazyZodSchema(() => z.strictObject({
  state: z.enum(['ready', 'checking', 'unavailable']), version: revision(), generation: nonempty(),
  items: z.array(LanguageIntelligenceDiagnosticSchema),
}));
export type LanguageIntelligenceDiagnosticsEntry = z.infer<typeof LanguageIntelligenceDiagnosticsEntrySchema>;
export const DaemonLspWatchRequestSchema = lazyZodSchema(() => z.strictObject({ rootPath: nonempty(), sinceRevision: z.optional(revision()) }));
export type DaemonLspWatchRequest = z.infer<typeof DaemonLspWatchRequestSchema>;
export const DaemonLspWatchResponseSchema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('ok'), revision: revision(), servers: z.array(LanguageIntelligenceServerStatusSchema),
    diagnostics: ownStringRecord(LanguageIntelligencePathSchema, ownStringRecord(nonempty(), LanguageIntelligenceDiagnosticsEntrySchema)) }),
  failureSchema,
]));
export type DaemonLspWatchResponse = z.infer<typeof DaemonLspWatchResponseSchema>;
export const DaemonLspRestartRequestSchema = lazyZodSchema(() => z.strictObject({ rootPath: nonempty(), serverId: z.optional(nonempty()) }));
export type DaemonLspRestartRequest = z.infer<typeof DaemonLspRestartRequestSchema>;
export const DaemonLspRestartResponseSchema = lazyZodSchema(() => z.union([z.strictObject({ status: z.literal('ok') }), failureSchema]));
export type DaemonLspRestartResponse = z.infer<typeof DaemonLspRestartResponseSchema>;

export type LanguageIntelligenceSyncInput = DaemonLspSyncRequest;
export type LanguageIntelligenceSyncResult = DaemonLspSyncResponse;
export type LanguageIntelligenceQueryInput = DaemonLspQueryRequest;
export type LanguageIntelligenceQueryResult = DaemonLspQueryResponse;
export type LanguageIntelligenceWatchInput = DaemonLspWatchRequest;
export type LanguageIntelligenceWatchResult = DaemonLspWatchResponse;
export type LanguageIntelligenceRestartInput = DaemonLspRestartRequest;
export type LanguageIntelligenceRestartResult = DaemonLspRestartResponse;
