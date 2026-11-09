import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { DocCollaborationActionInputSchemasV1 as inputs, DocCollaborationActionOutputSchemasV1 as outputs } from '../../artifacts/artifactCollaborationActionsV1.js';
import type { ActionSpecProjectionMetadata, PreNormalizedActionSpec } from '../actionSpecs.js';

type DocCollaborationActionSpec = {
  [Id in keyof typeof inputs]: ActionSpecProjectionMetadata & Readonly<{
    id: Id;
    approval: Id extends 'doc.read' ? { result: 'none' } : { result: 'optional'; flow: 'deferred' };
    requiredAuthority: Id extends 'doc.edit.accept' | 'doc.edit.decline' ? 'present_user' : 'account_automation';
    executionPlacement: 'account';
    placements: readonly [];
    surfaces: { ui: true; voice: Id extends 'doc.edit.accept' | 'doc.edit.decline' ? false : true; agent: true; mcp: true; cli: true; rpc: true };
    inputSchema: (typeof inputs)[Id];
    outputSchema: (typeof outputs)[Id];
    inputHints: { fields: readonly [] };
  }>;
}[keyof typeof inputs];

export const DOC_COLLABORATION_ACTION_SPECS_V1: readonly DocCollaborationActionSpec[] = lazyActionSpecArray(() => [
  { id: 'doc.read', title: 'Read document',
    description: 'Read an authorized prose Doc, including its document text, through the canonical Artifact reader. In a Doc passage thread, use the context docRef as ref; a supplied full revision must still be current. An unavailable comment count is explicit. Reading does not mark a Discussion read.',
    safety: 'safe', sideEffectClass: 'read', requiredAuthority: 'account_automation', executionPlacement: 'account',
    approval: { result: 'none' }, placements: [],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    bindings: { rpcMethod: 'doc.read', mcpToolName: 'doc_read', voiceClientToolName: 'doc_read' },
    inputSchema: inputs['doc.read'], outputSchema: outputs['doc.read'], inputHints: { fields: [] },
    cli: { acceptsServerId: true, commands: [{ path: ['doc', 'read'], visibility: 'canonical' }] },
  },
  { id: 'doc.comment.reply', title: 'Comment on a document passage',
    description: 'Post a passage comment or conversational reply through the canonical Discussion owner. When asked to suggest an edit or rewrite of document text, use doc.edit.propose to create a reviewable Doc suggestion. The exact revision-qualified passage and original local retry identity are retained; a comment does not edit document text.',
    safety: 'danger', sideEffectClass: 'danger', requiredAuthority: 'account_automation', executionPlacement: 'account',
    approval: { result: 'optional', flow: 'deferred' }, approvalPolicy: { uiConfirmation: 'direct' },
    placements: [],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    bindings: { rpcMethod: 'doc.comment.reply', mcpToolName: 'doc_comment_reply', voiceClientToolName: 'doc_comment_reply' },
    inputSchema: inputs['doc.comment.reply'], outputSchema: outputs['doc.comment.reply'], inputHints: { fields: [] },
    cli: { acceptsServerId: true, commands: [{ path: ['doc', 'comment', 'reply'], visibility: 'canonical' }] },
  },
  { id: 'doc.edit.propose', title: 'Propose a document edit',
    description: 'Use this action when asked to suggest an edit or rewrite of a document passage: it creates a reviewable Doc suggestion, while a conversational reply draft does not. Supply the complete paragraph(s) in the context suggestEdit.before as after, editing the selected span and keeping all text outside it verbatim unless the request asks otherwise. suggestEdit.beforeWithSelection marks the highlight with <selected_passage> tags; omit those annotation tags from after. Supply discussionRef from suggestEdit.discussionRef (or doc.threadRef.discussion), and localId, with an optional reason. documentPassage.quote is the person’s highlight; it may start or end mid-sentence. A paragraph includes the full sentences around the highlight and avoids splitting at soft wraps or abbreviations. The tool replaces the whole containing paragraph(s), never just that fragment. If suggestEdit.before is absent or the Doc changed, use doc.read with doc.docRef as ref and apply the same selection-only edit to the complete current paragraph(s) containing the passage. The thread supplies the exact full-paragraph target and revision before approval. Explicit target/baseRevision/before inputs retain their authored exact span; when composing a rewrite from a selection, supply the whole containing paragraph(s). after is used verbatim. A pending approval is not yet a submitted suggestion. A proposal never changes document text.',
    safety: 'danger', sideEffectClass: 'danger', requiredAuthority: 'account_automation', executionPlacement: 'account',
    approval: { result: 'optional', flow: 'deferred' }, approvalPolicy: { uiConfirmation: 'direct' },
    placements: [],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    bindings: { rpcMethod: 'doc.edit.propose', mcpToolName: 'doc_edit_propose', voiceClientToolName: 'doc_edit_propose' },
    inputSchema: inputs['doc.edit.propose'], outputSchema: outputs['doc.edit.propose'], inputHints: { fields: [] },
    approvalPresentation: { technicalInputPaths: ['target', 'baseRevision', 'discussionRef', 'replyTo', 'localId'] },
    cli: { acceptsServerId: true, commands: [{ path: ['doc', 'edit', 'propose'], visibility: 'canonical' }] },
  },
  { id: 'doc.edit.accept', title: 'Accept a document edit',
    description: 'Accept the exact stored proposal against the full expected document revision. Agents ask the entitled person by default; the person can allow it. The caller cannot provide replacement text.',
    safety: 'danger', sideEffectClass: 'danger', requiredAuthority: 'present_user', executionPlacement: 'account',
    approval: { result: 'optional', flow: 'deferred' }, approvalPolicy: { uiConfirmation: 'direct' },
    placements: [],
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: true },
    bindings: { rpcMethod: 'doc.edit.accept', mcpToolName: 'doc_edit_accept' },
    inputSchema: inputs['doc.edit.accept'], outputSchema: outputs['doc.edit.accept'], inputHints: { fields: [] },
    cli: { acceptsServerId: true, commands: [{ path: ['doc', 'edit', 'accept'], visibility: 'canonical' }] },
  },
  { id: 'doc.edit.decline', title: 'Decline a document edit',
    description: 'Decline the stored proposal. Declining settles the Discussion message without writing the document body. Agents ask the entitled person by default; the person can allow it.',
    safety: 'danger', sideEffectClass: 'danger', requiredAuthority: 'present_user', executionPlacement: 'account',
    approval: { result: 'optional', flow: 'deferred' }, approvalPolicy: { uiConfirmation: 'direct' },
    placements: [],
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: true },
    bindings: { rpcMethod: 'doc.edit.decline', mcpToolName: 'doc_edit_decline' },
    inputSchema: inputs['doc.edit.decline'], outputSchema: outputs['doc.edit.decline'], inputHints: { fields: [] },
    cli: { acceptsServerId: true, commands: [{ path: ['doc', 'edit', 'decline'], visibility: 'canonical' }] },
  },
] as const satisfies readonly PreNormalizedActionSpec[]);
