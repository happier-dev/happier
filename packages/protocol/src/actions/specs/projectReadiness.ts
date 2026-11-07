import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { ProjectReadinessReadInputV1Schema, ProjectReadinessReadResultV1Schema } from '../../projects/readinessV1.js';
import type { PreNormalizedActionSpec } from './definition.js';
import { actionInputServerId } from './definition.js';

export const PROJECT_READINESS_ACTION_SPECS_V1 = lazyActionSpecArray(() => [{
  id: 'projects.readiness.read', title: 'Read Project readiness',
  description: 'Read current CI, health-check, backup, alert-wiring, secret-scope and security-source facts for an exact Project and selected Environments. Missing owner projections remain unavailable; this read creates no configuration, schedule or Session.',
  approval: { result: 'none' }, safety: 'safe', requiredAuthority: 'account_automation', sideEffectClass: 'read', executionPlacement: 'machine',
  originalExecution: { daemonIngressSurfaces: ['cli', 'ui'] },
  inputSchema: ProjectReadinessReadInputV1Schema, outputSchema: ProjectReadinessReadResultV1Schema,
  placements: [], surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: true, rpc: false },
  bindings: { mcpToolName: 'projects_readiness_read' },
  invocationServerIdForInput: actionInputServerId(ProjectReadinessReadInputV1Schema, input => input.serverId),
  cli: { acceptsServerId: true, commands: [{ path: ['projects', 'readiness', 'read'], visibility: 'canonical' }] },
} as const satisfies PreNormalizedActionSpec]);
