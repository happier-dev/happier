import { MemoryActionInputSchemasV1 as inputs, MemoryActionOutputSchemasV1 as outputs } from '../../prompts/library/memoryActionsV1.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';

const common = {
  placements: [], executionPlacement: 'account', requiredAuthority: 'account_automation',
  inputHints: { fields: [] },
  surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
} as const;
export const MEMORY_DOCUMENT_ACTION_SPECS_V1 = [
  { ...common, id: 'memory.remember', title: 'Remember a fact', safety: 'danger', sideEffectClass: 'write',
    description: 'Remember sanitized text in the index, or in an optional named topic created within the same memory document. A Bot defaults to its own memory; an ordinary Session uses Project memory when present, else Account memory. Private writes are allowed; shared writes ask first and retain the reviewed document and revision without rebasing.',
    bindings: { mcpToolName: 'memory_remember', voiceClientToolName: 'memoryRemember' },
    cli: { acceptsServerId: true, commands: [{ path: ['memory', 'remember'], visibility: 'canonical' }] },
    inputSchema: inputs['memory.remember'], outputSchema: outputs['memory.remember'] },
  { ...common, id: 'memory.update', title: 'Update a remembered fact', safety: 'danger', sideEffectClass: 'write',
    description: 'Replace a fact at the reviewed Artifact revision and move its replacement to the optional destination topic (omitted means index). Preserve the previous fact in archive with host-derived provenance. Conflicts return the current version without rebasing.',
    bindings: { mcpToolName: 'memory_update', voiceClientToolName: 'memoryUpdate' },
    cli: { acceptsServerId: true, commands: [{ path: ['memory', 'update'], visibility: 'canonical' }] },
    inputSchema: inputs['memory.update'], outputSchema: outputs['memory.update'] },
  { ...common, id: 'memory.forget', title: 'Forget a remembered fact', safety: 'danger', sideEffectClass: 'write',
    description: 'Move a fact from the selected topic (omitted means index) into archive at the reviewed Artifact revision, without erasing searchable history. Conflicts return the current version.',
    bindings: { mcpToolName: 'memory_forget', voiceClientToolName: 'memoryForget' },
    cli: { acceptsServerId: true, commands: [{ path: ['memory', 'forget'], visibility: 'canonical' }] },
    inputSchema: inputs['memory.forget'], outputSchema: outputs['memory.forget'] },
  { ...common, id: 'memory.read', title: 'Read memory', safety: 'safe', sideEffectClass: 'read',
    description: 'Read the current memory index with topic titles and summaries, or only the named section when topic is supplied. The archive topic includes expired and previously replaced or forgotten facts. Return the observed header/body revision.',
    bindings: { mcpToolName: 'memory_read', voiceClientToolName: 'memoryRead' },
    cli: { acceptsServerId: true, commands: [{ path: ['memory', 'read'], visibility: 'canonical' }] },
    inputSchema: inputs['memory.read'], outputSchema: outputs['memory.read'] },
  { ...common, id: 'memory.list', title: 'List memory documents', safety: 'safe', sideEffectClass: 'read',
    description: 'Read one page from the Account Artifact inventory, preserving its coverage and continuation cursor.',
    bindings: { mcpToolName: 'memory_list', voiceClientToolName: 'memoryList' },
    cli: { acceptsServerId: true, commands: [{ path: ['memory', 'list'], visibility: 'canonical' }] },
    inputSchema: inputs['memory.list'], outputSchema: outputs['memory.list'] },
] as const satisfies readonly PreNormalizedActionSpec[];
