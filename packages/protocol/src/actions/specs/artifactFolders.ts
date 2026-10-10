import { ARTIFACT_FOLDER_ACTION_IDS_V1, type ArtifactFolderActionIdV1 } from '../../prompts/library/artifactFolderActionIdsV1.js';
import { ARTIFACT_FOLDER_ACTION_INPUT_SCHEMAS_V1, ARTIFACT_FOLDER_ACTION_OUTPUT_SCHEMAS_V1 } from '../../prompts/library/promptFolderActionSchemasV1.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';

/** What a person reads in Settings, approvals and the form. Agents read `description`. */
const ARTIFACT_FOLDER_ACTION_COPY = {
  'artifact.folders.list': ['List library folders', 'Read your personal folder tree, including empty folders.'],
  'artifact.folders.read': ['Read library folder', 'Read a folder by its id, with its current catalog revision.'],
  'artifact.folders.create': ['Create document folder', 'Add a folder to keep documents in.'],
  'artifact.folders.rename': ['Rename document folder', 'Change a folder\'s name.'],
  'artifact.folders.move': ['Move document folder', 'Put a folder inside another folder, or back at the top.'],
  'artifact.folders.delete': ['Delete document folder', 'Remove a folder. The documents in it are kept.'],
  'artifact.folder.set': ['Move document to folder', 'Put a document in a folder, or take it out of one.'],
} as const satisfies Record<ArtifactFolderActionIdV1, readonly [title: string, summary: string]>;

export const ARTIFACT_FOLDER_ACTION_SPECS_V1 = ARTIFACT_FOLDER_ACTION_IDS_V1.map(id => ({
  id, title: ARTIFACT_FOLDER_ACTION_COPY[id][0],
  description: 'Organize Artifacts in your personal folder tree without changing document contents or sharing.',
  safety: 'safe', sideEffectClass: id === 'artifact.folders.list' || id === 'artifact.folders.read' ? 'read' : 'write',
  requiredAuthority: 'account_automation', executionPlacement: 'account', placements: [],
  surfaces: { ui: true, cli: true, agent: true, mcp: true, rpc: true, voice: false },
  bindings: { rpcMethod: id, mcpToolName: id.replaceAll('.', '_') },
  inputSchema: ARTIFACT_FOLDER_ACTION_INPUT_SCHEMAS_V1[id], outputSchema: ARTIFACT_FOLDER_ACTION_OUTPUT_SCHEMAS_V1[id],
  inputHints: { description: ARTIFACT_FOLDER_ACTION_COPY[id][1], fields: [] },
  cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' }] },
}) satisfies PreNormalizedActionSpec);
