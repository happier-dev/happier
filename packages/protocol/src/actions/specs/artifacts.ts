import type { PreNormalizedActionSpec } from './definition.js';
import { readRecord } from '../../inputs/inputRecords.js';
import { ACCOUNT_NOTICE_ARTIFACT_KIND_V1, USAGE_NOTICE_ARTIFACT_KIND_V1 } from '../../activity/accountNoticeArtifactKindsV1.js';
import { redactPublicShareCapabilityUrl } from '../../crypto/publicShareCapabilityUrl.js';
import { ARTIFACT_ACCESS_ACTION_IDS_V1, ArtifactAccessActionInputSchemasV1, ArtifactAccessActionOutputSchemasV1 } from '../../artifacts/artifactAccessV1.js';
import { ARTIFACT_ACTION_IDS_V1, ArtifactActionInputSchemasV1, ArtifactActionOutputSchemasV1, type ArtifactActionIdV1 } from '../../artifacts/artifactActionsV1.js';


export const ARTIFACT_ACCESS_ACTION_SPECS: readonly (PreNormalizedActionSpec & Readonly<{
  requiredAuthority: 'account_automation';
}>)[] = ARTIFACT_ACCESS_ACTION_IDS_V1.map((id) => ({
  id, approval: { result: 'required' }, title: id === 'artifact.access.grants.list' ? 'List document sharing' : id === 'artifact.access.grants.set' ? 'Share document' : 'Remove document sharing',
  description: 'Manage sharing through the document kind owner and authenticated Artifact grants.',
  safety: id === 'artifact.access.grants.list' ? 'safe' : 'danger',
  sideEffectClass: id === 'artifact.access.grants.list' ? 'read' : 'write',
  // Anything a person can do here an agent can do too (owner rule; INT review F-18): the same
  // authority and approval policy as Session access grants, so widening access still asks. The
  // present user pressing Add or Remove in the share sheet is the confirmation, as for Session grants.
  ...(id === 'artifact.access.grants.list' ? {} : { approvalPolicy: { uiConfirmation: 'direct' as const } }),
  requiredAuthority: 'account_automation', executionPlacement: 'account', placements: [],
  bindings: { rpcMethod: id, mcpToolName: id.replaceAll('.', '_'), voiceClientToolName: id.replaceAll('.', '_') },
  surfaces: { ui: true, cli: true, rpc: true, agent: true, mcp: true, voice: true },
  inputSchema: ArtifactAccessActionInputSchemasV1[id], outputSchema: ArtifactAccessActionOutputSchemasV1[id],
  inputHints: { title: 'Document sharing', fields: [] },
  cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' }] },
}));

export function projectPublicLinkCreationObservation(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const result = value as Record<string, unknown>;
  return { ...result,
    ...(typeof result.url === 'string' ? { url: redactPublicShareCapabilityUrl(result.url) } : {}),
    ...(typeof result.previewUrl === 'string' ? { previewUrl: redactPublicShareCapabilityUrl(result.previewUrl) } : {}),
  };
}

// What a person reads in Settings, approvals and the form. Agents read `description`.
export const ARTIFACT_ACTION_COPY = {
  'artifact.create': ['Create document', 'Save a new document to your account.'],
  'artifact.get': ['Read document', 'Open one document and read what is in it.'],
  'artifact.export': ['Export document file', 'Save a binary document into the invoking session’s workspace or download it on the answering client. Portable Role and Profile documents save on the answering client. Existing workspace files are preserved unless overwrite is approved.'],
  'artifact.list': ['List documents', 'See the documents saved in your account.'],
  'artifact.update': ['Update document', 'Save a new version of a document. Earlier versions are kept.'],
  'artifact.delete': ['Delete document', 'Remove a document from your account. People it was shared with lose it too.'],
  'artifact.publish_from_file': ['Save a file as a document', 'Turn a file on a machine into a document in your account.'],
  'artifact.revisions.list': ['List document versions', 'See the earlier versions of a document.'],
  'artifact.revisions.restore': ['Restore document version', 'Make an earlier version of a document the current one.'],
  'artifact.storage.usage': ['Read document storage', 'See how much space your documents take.'],
  'artifact.public_link.create': ['Create document public link', 'Make a link that lets anyone who has it read a document.'],
  'artifact.public_link.list': ['List document public links', 'See the public links a document has.'],
  'artifact.public_link.join': ['Open signed-in document link', 'Join a signed-in document link with Can copy access.'],
  'artifact.public_link.revoke': ['Turn off document public link', 'Stop a public link working. People who have it can no longer open the document.'],
  'artifact.public_link.audit': ['Read document public link activity', 'See when a document\'s public link was opened.'],
} as const satisfies Record<ArtifactActionIdV1, readonly [title: string, summary: string]>;

export function isAnsweringClientArtifactExport(input: unknown): boolean {
  return Object.hasOwn(readRecord(input), 'portable') || readRecord(input).destination === 'client';
}

export const ARTIFACT_ACTION_SPECS: readonly (PreNormalizedActionSpec & Readonly<{
  requiredAuthority: 'account_automation';
}>)[] = ARTIFACT_ACTION_IDS_V1.map((id): PreNormalizedActionSpec & Readonly<{ requiredAuthority: 'account_automation' }> => {
  const read = id === 'artifact.get' || id === 'artifact.list' || id === 'artifact.revisions.list' || id === 'artifact.storage.usage' || id === 'artifact.public_link.audit';
  const voice = id !== 'artifact.export';
  return {
    id, approval: { result: 'required' },
    ...(id === 'artifact.delete'
      ? { irreversible: true as const, confirmVerb: { key: 'common.delete', fallback: 'Delete' } } : {}),
    ...(id === 'artifact.public_link.revoke' ? { irreversible: true as const } : {}),
    ...(id === 'artifact.export' ? { approvalPolicy: {
      uiConfirmation: 'direct' as const,
      uiConfirmationForInput: (input: unknown) => !isAnsweringClientArtifactExport(input),
    }, executionPlacements: ['client', 'machine'] as const,
      executionPlacementForInput: (input: unknown) => isAnsweringClientArtifactExport(input) ? 'client' as const : 'machine' as const } : {}),
    ...(id === 'artifact.public_link.audit' ? { approvalPolicy: { agentDefault: 'egress' as const } } : {}),
    // Opening the share sheet reads the document's links; a present-user read is not confirmed.
    ...(id === 'artifact.public_link.list' || id === 'artifact.public_link.join' ? { approvalPolicy: { uiConfirmation: 'direct' as const } } : {}),
    // Both create a new private Account document (artifactActionDeps#createDocument).
    // Public-link creation carries its own in-page network choice (owner ruling
    // 2026-10-16); existing-document edits and revocation stay confirmed.
    ...(id === 'artifact.create' || id === 'artifact.publish_from_file' || id === 'artifact.public_link.create'
      ? { approvalPolicy: { uiConfirmation: 'direct' as const } } : {}),
    // The present user's own Inbox notice read or dismissal is reversible bookkeeping on a private
    // notice; the executor admits only those exact notice transitions. Document edits stay confirmed.
    ...(id === 'artifact.update' ? { approvalPolicy: {
      uiConfirmation: 'direct' as const,
      uiConfirmationForInput: (input: unknown) => {
        const header = readRecord(readRecord(input).header);
        return header.kind !== USAGE_NOTICE_ARTIFACT_KIND_V1 && header.kind !== ACCOUNT_NOTICE_ARTIFACT_KIND_V1;
      },
    } } : {}),
    title: ARTIFACT_ACTION_COPY[id][0], description: id === 'artifact.export' ? ARTIFACT_ACTION_COPY[id][1]
      : 'Read, publish and manage ordinary Account Artifacts through their mode-aware store.',
    safety: read ? 'safe' : 'danger', sideEffectClass: read || id === 'artifact.public_link.list' ? 'read' : 'write',
    requiredAuthority: 'account_automation', executionPlacement: id === 'artifact.publish_from_file' || id === 'artifact.export' ? 'machine' : 'account',
    placements: [], bindings: { rpcMethod: id, mcpToolName: id.replaceAll('.', '_'),
      ...(voice ? { voiceClientToolName: id.replaceAll('.', '_') } : {}) },
    surfaces: { ui: true, cli: true, rpc: true, agent: true, mcp: true,
      voice },
    inputSchema: ArtifactActionInputSchemasV1[id], outputSchema: ArtifactActionOutputSchemasV1[id],
    ...(['artifact.public_link.create', 'artifact.create', 'artifact.update', 'artifact.publish_from_file', 'artifact.get', 'artifact.revisions.restore'].includes(id)
      ? { projectObservationOutput: projectPublicLinkCreationObservation } : {}),
    inputHints: { title: ARTIFACT_ACTION_COPY[id][0], description: ARTIFACT_ACTION_COPY[id][1], fields: id === 'artifact.publish_from_file' ? [
      { path: 'path', title: 'File path', widget: 'text', required: true,
        description: 'File within the source workspace. Without workspace, the admitted caller Session supplies the source.' },
      { path: 'workspace', title: 'Source workspace', widget: 'json',
        description: 'Explicit {machineId, rootPath} source. Overrides an ambient Session; the host must support this Machine workspace or refuse the operation.' },
      { path: 'title', title: 'Document title', widget: 'text' },
    ] : id === 'artifact.export' ? [
      { path: 'artifactId', title: 'Document', widget: 'text', description: 'Binary document to export.' },
      { path: 'destination', title: 'Destination', widget: 'text', description: 'Use client to download on the answering client, retaining its platform file chooser.' },
      { path: 'fileName', title: 'Download name', widget: 'text', description: 'Optional answering-client file name; otherwise the current document title is used.' },
      { path: 'reference', title: 'File revision', widget: 'json', description: 'Optional exact binary reference from a document revision. Omit to download the current file.' },
      { path: 'path', title: 'Workspace path', widget: 'text', description: 'Workspace-relative destination for the existing Session workspace export.' },
      { path: 'overwrite', title: 'Overwrite', widget: 'boolean', description: 'Allow replacing an existing workspace file.' },
      { path: 'portable', title: 'Portable document', widget: 'json', description: 'Role or Launch-profile document to save on the answering client.' },
    ] : [] },
    cli: { acceptsServerId: true, commands: [{ path: id.split('.').map((segment) => segment.replaceAll('_', '-')), visibility: 'canonical' }] },
  };
});
