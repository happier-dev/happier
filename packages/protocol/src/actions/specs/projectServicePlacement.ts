import { ProjectServicePlacementGetV1Schema, ProjectServicePlacementSetV1Schema,
  ProjectServicePlacementGetResultV1Schema, ProjectServicePlacementMutationResultV1Schema,
  type ProjectServicePlacementGetV1, type ProjectServicePlacementSetV1,
} from '../../workspaces/projectServicePlacementV1.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';

export const PROJECT_SERVICE_PLACEMENT_ACTION_IDS_V1 = [
  'projects.service.placement.get', 'projects.service.placement.set',
] as const;
export const ProjectServicePlacementActionInputSchemasV1 = {
  'projects.service.placement.get': ProjectServicePlacementGetV1Schema,
  'projects.service.placement.set': ProjectServicePlacementSetV1Schema,
} as const;
export const ProjectServicePlacementActionOutputSchemasV1 = {
  'projects.service.placement.get': ProjectServicePlacementGetResultV1Schema,
  'projects.service.placement.set': ProjectServicePlacementMutationResultV1Schema,
} as const;
const voiceInputs = {
  'projects.service.placement.get': { workspace: { serverId: 'home', refId: 'checkout' }, serviceName: 'web' },
  'projects.service.placement.set': { workspace: { serverId: 'home', refId: 'checkout' }, serviceName: 'web',
    expectedRevision: 'absent', expected: { kind: 'absent' }, value: { runsOn: { kind: 'primary' }, unavailable: 'fail' } },
} satisfies { 'projects.service.placement.get': ProjectServicePlacementGetV1; 'projects.service.placement.set': ProjectServicePlacementSetV1 };
export const PROJECT_SERVICE_PLACEMENT_ACTION_SPECS = PROJECT_SERVICE_PLACEMENT_ACTION_IDS_V1.map((id): PreNormalizedActionSpec => {
  const read = id.endsWith('.get');
  const title = read ? 'Read service placement' : 'Set service placement';
  return {
    id, title, description: read ? 'Read desired next-start placement and separately observed actual native service custody.'
      : 'Save the destination and fallback for the next service start without starting or moving the service.',
    safety: read ? 'safe' : 'danger', sideEffectClass: read ? 'read' : 'write', executionPlacement: 'account', placements: [],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    bindings: { mcpToolName: id.replaceAll('.', '_'), voiceClientToolName: id.replaceAll('.', '_') },
    cli: { commands: [{ path: id.split('.'), visibility: 'canonical' }] },
    inputHints: { title, fields: [] }, inputSchema: ProjectServicePlacementActionInputSchemasV1[id],
    examples: { voice: { argsExample: JSON.stringify(voiceInputs[id]) } },
    outputSchema: ProjectServicePlacementActionOutputSchemasV1[id],
  };
});
