import { ARTIFACT_FOLDER_ACTION_IDS_V1 } from '../../prompts/library/artifactFolderActionIdsV1.js';
import { ARTIFACT_FOLDER_ACTION_INPUT_SCHEMAS_V1, ARTIFACT_FOLDER_ACTION_OUTPUT_SCHEMAS_V1 } from '../../prompts/library/promptFolderActionsV1.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';

export const ARTIFACT_FOLDER_ACTION_SPECS_V1 = ARTIFACT_FOLDER_ACTION_IDS_V1.map(id => ({
  id, title: id === 'artifact.folder.set' ? 'Move Artifact to folder' : `${id.split('.').at(-1)} folder`,
  description: 'Organize Artifacts in your personal folder tree without changing document contents or sharing.',
  safety: 'safe', sideEffectClass: 'write', requiredAuthority: 'account_automation', executionPlacement: 'account', placements: [],
  surfaces: { ui: true, cli: true, agent: true, mcp: true, rpc: true, voice: false },
  bindings: { rpcMethod: id, mcpToolName: id.replaceAll('.', '_') },
  inputSchema: ARTIFACT_FOLDER_ACTION_INPUT_SCHEMAS_V1[id], outputSchema: ARTIFACT_FOLDER_ACTION_OUTPUT_SCHEMAS_V1[id],
  inputHints: { fields: [] },
  cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' }] },
}) satisfies PreNormalizedActionSpec);
