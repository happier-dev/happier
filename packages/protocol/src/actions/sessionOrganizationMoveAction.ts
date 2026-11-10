import { lazyActionSpecArray } from './lazyActionSpecValue.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { EntityDragScopeV1Schema } from '../plugins/ui/entityDragDrop.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';
import { SetSessionPinRequestSchema, SetSessionPinResponseSchema } from '../sessions/organization/mutations.js';
import { SESSION_ORGANIZATION_MAX_ID_LENGTH } from '../sessions/organization/constants.js';
import { SESSION_ORGANIZATION_PIN_HTTP_PATH_V1 } from '../sessions/organization/pins.js';
import { SessionAppearanceColorSchema } from '../sessions/organization/appearances.js';

const id = z.string().check(z.trim(), z.minLength(1));
/** Stable semantic anchors, never a drag snapshot or a replacement order array. */
export const SessionOrganizationMoveInputSchema = lazyZodSchema(() => z.strictObject({
  scope: EntityDragScopeV1Schema,
  projection: z.optional(z.literal('rail')),
  sourceRowId: id,
  sourceKind: z.enum(['leaf', 'container']),
  instructionKind: z.enum(['reorder-before', 'reorder-after', 'nest-into', 'move-to-root']),
  targetRowId: z.nullable(id),
  containerId: z.nullable(id),
  parentRowId: z.nullable(id),
  depth: z.nullable(z.number().check(z.int(), z.nonnegative())),
  edge: z.nullable(z.enum(['top', 'bottom'])),
}));
export type SessionOrganizationMoveInput = z.infer<typeof SessionOrganizationMoveInputSchema>;
export const SessionOrganizationMoveOutputSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('applied') }),
  z.strictObject({ status: z.literal('refused'), reason: id }),
  z.strictObject({ status: z.literal('unavailable') }),
  z.strictObject({ status: z.literal('unknown'), reason: id }),
]));
export type SessionOrganizationMoveOutput = z.infer<typeof SessionOrganizationMoveOutputSchema>;

export const SessionOrganizationPinSetInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SetSessionPinRequestSchema, {
  sessionId: id.check(z.maxLength(SESSION_ORGANIZATION_MAX_ID_LENGTH)),
  serverId: z.optional(id),
})));
export type SessionOrganizationPinSetInput = z.infer<typeof SessionOrganizationPinSetInputSchema>;

export const SessionOrganizationAppearanceSetInputSchema = lazyZodSchema(() => z.strictObject({
  sessionId: id, color: z.nullable(SessionAppearanceColorSchema), serverId: z.optional(id),
}));
export const ProjectOrganizationColorSetInputSchema = lazyZodSchema(() => z.strictObject({
  workspaceKey: id, color: z.nullable(SessionAppearanceColorSchema), serverId: z.optional(id),
}));
export type SessionOrganizationAppearanceActionInput =
  | z.infer<typeof SessionOrganizationAppearanceSetInputSchema>
  | z.infer<typeof ProjectOrganizationColorSetInputSchema>;
export const SessionOrganizationAppearanceSetOutputSchema = lazyZodSchema(() => z.strictObject({ status: z.literal('applied') }));

function createSessionOrganizationMoveActionSpecs() {
  return [{
  id: 'session.organization.move', approval: {result: 'required'}, title: 'Move Session organization item',
  cli: { commands: [{ path: ['session', 'organization', 'move'], visibility: 'canonical' }] },
  description: 'Move a Session, folder or workspace through the mounted Session list organization owner. Current membership, Home, Account and ordering policy are revalidated before writing. Session reporting relationships use session.manager.set.',
  safety: 'safe', sideEffectClass: 'write', requiredAuthority: 'account_automation', executionPlacement: 'client',
  placements: [], bindings: { mcpToolName: 'session_organization_move' },
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
  inputSchema: SessionOrganizationMoveInputSchema, outputSchema: SessionOrganizationMoveOutputSchema,
  inputHints: { fields: [
    { path: 'scope', title: 'Home and Account', widget: 'json', required: true,
      description: 'The mounted list’s captured serverId and accountId. This identifies the list, not permission to edit it.' },
    { path: 'projection', title: 'List projection', widget: 'select', options: [{ value: 'rail', label: 'Bot rail' }],
      description: 'Omit for the Session list; select rail for the mounted Bot rail.' },
    { path: 'sourceRowId', title: 'Source row', widget: 'text', required: true },
    { path: 'sourceKind', title: 'Source kind', widget: 'select', required: true,
      options: [{ value: 'leaf', label: 'Session' }, { value: 'container', label: 'Folder or workspace' }] },
    { path: 'instructionKind', title: 'Move instruction', widget: 'select', required: true, options: [
      { value: 'reorder-before', label: 'Before anchor' }, { value: 'reorder-after', label: 'After anchor' },
      { value: 'nest-into', label: 'Into container' }, { value: 'move-to-root', label: 'To root' },
    ] },
    { path: 'targetRowId', title: 'Target anchor', widget: 'json', required: true,
      description: 'Current target row id as a string, or null when the instruction has no anchor.' },
    { path: 'containerId', title: 'Destination container', widget: 'json', required: true,
      description: 'Current folder or workspace id as a string, or null for the root.' },
    { path: 'parentRowId', title: 'Destination parent row', widget: 'json', required: true,
      description: 'Current parent row id as a string, or null for the root.' },
    { path: 'depth', title: 'Destination depth', widget: 'json', required: true,
      description: 'Nonnegative integer depth, or null when no depth applies.' },
    { path: 'edge', title: 'Anchor edge', widget: 'select', required: true,
      options: [{ value: 'top', label: 'Top' }, { value: 'bottom', label: 'Bottom' }, { value: null, label: 'No edge' }] },
  ] },
}, {
  id: 'session.organization.pin.set', approval: {result: 'required'}, title: 'Set personal Session pin',
  description: 'Set only the named personal list or Bot rail pin membership on the selected Home. Omitted surface means list. Rail additions require an existing Bot marker and never promote the Session. Ordering is shared across memberships.',
  safety: 'safe', sideEffectClass: 'write', requiredAuthority: 'account_automation', executionPlacement: 'account',
  placements: [], bindings: { mcpToolName: 'session_organization_pin_set' },
  surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
  inputSchema: SessionOrganizationPinSetInputSchema, outputSchema: SetSessionPinResponseSchema,
  serverTransport: { method: 'PUT', path: SESSION_ORGANIZATION_PIN_HTTP_PATH_V1 },
  inputHints: { fields: [
    { path: 'sessionId', title: 'Session', prompt: 'Which session?', widget: 'text', required: true },
    { path: 'pinned', title: 'Pinned', widget: 'boolean', required: true },
    { path: 'surface', title: 'Pin surface', widget: 'select', options: [{ value: 'list', label: 'Session list' }, { value: 'rail', label: 'Bot rail' }] },
  ] },
}, {
  id: 'session.organization.appearance.set', approval: { result: 'required' }, title: 'Set personal Session color',
  originalExecution: { accountRoot: 'allowed', terminalRoot: 'allowed' },
  description: 'Save a personal Session color on the selected Home and Account, or reset it with null to reveal its Project-group color. Uses the existing encrypted organization appearance owner.',
  safety: 'safe', sideEffectClass: 'write', requiredAuthority: 'account_automation', executionPlacement: 'client',
  placements: [], bindings: { mcpToolName: 'session_organization_appearance_set' },
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
  inputSchema: SessionOrganizationAppearanceSetInputSchema, outputSchema: SessionOrganizationAppearanceSetOutputSchema,
  cli: { commands: [{ path: ['session', 'organization', 'appearance', 'set'], visibility: 'canonical' }] },
  inputHints: { fields: [
    { path: 'sessionId', title: 'Session', widget: 'text', required: true },
    { path: 'color', title: 'Named accent or custom hex color, or null to reset', widget: 'json', required: true },
  ] },
}, {
  id: 'projects.organization.color.set', approval: { result: 'required' }, title: 'Set personal Project-group color',
  originalExecution: { accountRoot: 'allowed', terminalRoot: 'allowed' },
  description: 'Save or reset the personal Work Project-group color using its exact workspaceKey. A null color resets it; the private label and all other display fields are preserved by the organization owner.',
  safety: 'safe', sideEffectClass: 'write', requiredAuthority: 'account_automation', executionPlacement: 'client',
  placements: [], bindings: { mcpToolName: 'projects_organization_color_set' },
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
  inputSchema: ProjectOrganizationColorSetInputSchema, outputSchema: SessionOrganizationAppearanceSetOutputSchema,
  cli: { commands: [{ path: ['projects', 'organization', 'color', 'set'], visibility: 'canonical' }] },
  inputHints: { fields: [
    { path: 'workspaceKey', title: 'Project-group workspace key', widget: 'text', required: true },
    { path: 'color', title: 'Named accent or custom hex color, or null to reset', widget: 'json', required: true },
  ] },
}] as const satisfies readonly PreNormalizedActionSpec[];
}

export const SESSION_ORGANIZATION_MOVE_ACTION_SPECS: ReturnType<typeof createSessionOrganizationMoveActionSpecs> = lazyActionSpecArray(createSessionOrganizationMoveActionSpecs);
