import {
  SessionMessageProvenanceV1Schema,
  type SessionMessageProvenanceV1,
} from './sessionInputAdmission.js';
import {
  renderComposerReferenceContextBlockV1,
  type ComposerAttachmentContextBlockEntryV1,
  type ComposerReferenceContextBlockEntryV1,
} from '../../runtime/input/composerReferenceProviderV1.js';

const MAX_CONTEXT_VALUE_CODE_POINTS = 128;
const MAX_CONTEXT_BLOCK_CODE_POINTS = 1_024;

function normalizeBoundedContextValue(value: string): string {
  return Array.from(value.normalize('NFC')).slice(0, MAX_CONTEXT_VALUE_CODE_POINTS).join('');
}

function encodeContextValue(value: string): string {
  return JSON.stringify(normalizeBoundedContextValue(value))
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e');
}

function sourceKindForProvenance(provenance: SessionMessageProvenanceV1): string {
  return provenance.kind === 'host' ? provenance.producer : provenance.kind;
}

function shouldOmitContextBlock(provenance: SessionMessageProvenanceV1): boolean {
  return provenance.kind === 'cli'
    || provenance.kind === 'happierApp' && provenance.actor.kind === 'owner';
}

/**
 * Renders model-visible descriptive context only. No caller may parse this
 * text back into authority; protected metadata remains the sole authority.
 */
export function renderSessionInputContextBlockV1(params: Readonly<{
  provenance: SessionMessageProvenanceV1;
  collaboratorDisplayName?: string;
}>): string {
  const provenance = SessionMessageProvenanceV1Schema.parse(params.provenance);
  if (shouldOmitContextBlock(provenance)) return '';

  const lines: string[] = [
    `source_kind=${encodeContextValue(sourceKindForProvenance(provenance))}`,
  ];
  if (provenance.kind === 'happierSession') {
    lines.push(`source_session_id=${encodeContextValue(provenance.sourceSessionId)}`);
    lines.push('reply_action="session.message.send"');
  }
  if (provenance.kind === 'automation') {
    lines.push(`automation_id=${encodeContextValue(provenance.automationId)}`);
    lines.push(`automation_run_id=${encodeContextValue(provenance.runId)}`);
  }
  if (provenance.kind === 'pluginSession') {
    lines.push(`plugin_id=${encodeContextValue(provenance.pluginId)}`);
    lines.push(`contribution_local_id=${encodeContextValue(provenance.contributionLocalId)}`);
    if (provenance.externalActor && provenance.contentProvenance) {
      lines.push(`external_sender_kind=${encodeContextValue(provenance.externalActor.kind)}`);
      lines.push(`content_provenance=${encodeContextValue(provenance.contentProvenance)}`);
    }
  }
  if (provenance.kind === 'happierApp' && provenance.actor.kind === 'sharedCollaborator') {
    lines.push('happier_actor="collaborator"');
  }
  if (provenance.kind === 'pluginSession' && provenance.externalActor?.displayNameSnapshot) {
    lines.push(`external_sender_display_name=${encodeContextValue(provenance.externalActor.displayNameSnapshot)}`);
  }
  if (
    provenance.kind === 'happierApp'
    && provenance.actor.kind === 'sharedCollaborator'
    && typeof params.collaboratorDisplayName === 'string'
    && params.collaboratorDisplayName.trim().length > 0
  ) {
    lines.push(`happier_actor_display_name=${encodeContextValue(params.collaboratorDisplayName)}`);
  }

  const open = '<happier_input_context v="1">';
  const close = '</happier_input_context>';
  while (lines.length > 1) {
    const rendered = [open, ...lines, close].join('\n');
    if (Array.from(rendered).length <= MAX_CONTEXT_BLOCK_CODE_POINTS) return rendered;
    lines.pop();
  }
  return [open, ...lines, close].join('\n');
}

export function renderSessionInputContextPromptV1(params: Readonly<{
  provenanceBlock?: string;
  sessionReferenceBlock?: string;
  composerReferences?: readonly ComposerReferenceContextBlockEntryV1[];
  composerAttachments?: readonly ComposerAttachmentContextBlockEntryV1[];
  transformedUserText: string;
}>): string {
  const composerBlock = renderComposerReferenceContextBlockV1(
    params.composerReferences ?? [],
    params.composerAttachments ?? [],
  );
  return [
    params.provenanceBlock ?? '',
    params.sessionReferenceBlock ?? '',
    composerBlock,
    params.transformedUserText,
  ].filter((block) => block.length > 0).join('\n\n');
}
