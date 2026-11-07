import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { ProjectServicePlacementGetV1Schema, ProjectServicePlacementSetV1Schema,
  ProjectServicePlacementGetResultV1Schema, ProjectServicePlacementMutationResultV1Schema,
  type ProjectServicePlacementGetV1, type ProjectServicePlacementSetV1,
} from '../../workspaces/projectServicePlacementV1.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import type { ActionInputFieldHint } from '../actionInputHintsRuntime.js';

type ProjectServicePlacementActionInputSchemas = Readonly<{
  'projects.service.placement.get': typeof ProjectServicePlacementGetV1Schema;
  'projects.service.placement.set': typeof ProjectServicePlacementSetV1Schema;
}>;
type ProjectServicePlacementActionOutputSchemas = Readonly<{
  'projects.service.placement.get': typeof ProjectServicePlacementGetResultV1Schema;
  'projects.service.placement.set': typeof ProjectServicePlacementMutationResultV1Schema;
}>;
export const ProjectServicePlacementActionInputSchemasV1: ProjectServicePlacementActionInputSchemas = {
  'projects.service.placement.get': ProjectServicePlacementGetV1Schema,
  'projects.service.placement.set': ProjectServicePlacementSetV1Schema,
} as const;
export const ProjectServicePlacementActionOutputSchemasV1: ProjectServicePlacementActionOutputSchemas = {
  'projects.service.placement.get': ProjectServicePlacementGetResultV1Schema,
  'projects.service.placement.set': ProjectServicePlacementMutationResultV1Schema,
} as const;
const targetFields = [
  { path: 'workspace', title: 'Workspace', widget: 'json', required: true },
  { path: 'serviceName', title: 'Service', widget: 'text', required: true },
] satisfies ActionInputFieldHint[];
const inputFields = {
  'projects.service.placement.get': targetFields,
  'projects.service.placement.set': [...targetFields,
    { path: 'expectedRevision', title: 'Expected revision', widget: 'json', required: true },
    { path: 'expected', title: 'Reviewed service placement', widget: 'json', required: true },
    { path: 'value', title: 'New service placement', widget: 'json', required: true }],
} satisfies Record<typeof PROJECT_SERVICE_PLACEMENT_ACTION_IDS_V1[number], ActionInputFieldHint[]>;
const voiceInputs = {
  'projects.service.placement.get': { workspace: { serverId: 'home', refId: 'checkout' }, serviceName: 'web' },
  'projects.service.placement.set': { workspace: { serverId: 'home', refId: 'checkout' }, serviceName: 'web',
    expectedRevision: 'absent', expected: { kind: 'absent' }, value: { runsOn: { kind: 'primary' }, unavailable: 'fail' } },
} satisfies { 'projects.service.placement.get': ProjectServicePlacementGetV1; 'projects.service.placement.set': ProjectServicePlacementSetV1 };
function createProjectServicePlacementActionSpecs() {
  return PROJECT_SERVICE_PLACEMENT_ACTION_IDS_V1.map((id): PreNormalizedActionSpec => {
  const read = id.endsWith('.get');
  const title = read ? 'Read service placement' : 'Set service placement';
  return {
    id, approval: read ? { result: 'required' } : { result: 'optional', flow: 'deferred' },
    approvalPolicy: { uiConfirmation: 'direct' }, title, description: read ? 'Read desired next-start placement and separately observed actual native service custody.'
      : 'Save the destination and fallback for the next service start without starting or moving the service.',
    safety: read ? 'safe' : 'danger', sideEffectClass: read ? 'read' : 'write', executionPlacement: 'account', placements: [],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    bindings: { mcpToolName: id.replaceAll('.', '_'), voiceClientToolName: id.replaceAll('.', '_') },
    cli: { commands: [{ path: id.split('.'), visibility: 'canonical' }] },
    inputHints: { title, fields: inputFields[id] }, inputSchema: ProjectServicePlacementActionInputSchemasV1[id],
    examples: { voice: { argsExample: JSON.stringify(voiceInputs[id]) } },
    outputSchema: ProjectServicePlacementActionOutputSchemasV1[id],
  };
});
}

export const PROJECT_SERVICE_PLACEMENT_ACTION_SPECS: ReturnType<typeof createProjectServicePlacementActionSpecs> = lazyActionSpecArray(createProjectServicePlacementActionSpecs);
import { PROJECT_SERVICE_PLACEMENT_ACTION_IDS_V1 } from './projectWorkersActionIdsV1.js';
export { PROJECT_SERVICE_PLACEMENT_ACTION_IDS_V1 } from './projectWorkersActionIdsV1.js';
