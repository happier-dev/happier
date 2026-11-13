import { lazyActionSpecArray } from '../../lazyActionSpecValue.js';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { SessionAccessEncryptionPrepareInputV1Schema, SessionAccessEncryptionReprepareInputV1Schema, SessionAccessEncryptionPrepareResultV1Schema, SessionAccessLayoutUpdateResultV1Schema } from '../../../sessions/access/sessionAccessActionsV1.js';
import { SessionTargetV1Schema } from '../../sessionTargetV1.js';
import { sameStrictJsonValue } from '../../../json/strictJsonValue.js';
import { SessionAccessGrantsListRequestV1Schema, SessionAccessGrantsListResponseV1Schema, SetSessionAccessGrantResponseV1Schema, RemoveSessionAccessGrantRequestV1Schema, RemoveSessionAccessGrantResponseV1Schema, SetSessionAccessContextRequestV1Schema, SetSessionAccessContextResponseV1Schema } from '../../../sessions/access/sessionAccessOperationsV1.js';
import { SessionAccessGrantSetActionInputV1Schema, SessionPublicLinkCreateActionInputV1Schema, SessionPublicLinkCreateActionResultV1Schema, SessionPublicLinkGetActionResultV1Schema, SessionPublicLinkRemoveActionResultV1Schema } from '../../../sessions/access/sessionAccessActionsV1.js';
import { SetSessionResponsibilityRequestSchema, SetSessionResponsibilityResponseSchema, SessionResponsibilityCandidatesRequestSchema, SessionResponsibilityCandidatesResponseSchema } from '../../../sessions/access/sessionResponsibilityV1.js';
import { z } from '../../../zodRuntimePolicy.js';
import { SessionManagerSetActionInputV1Schema, SessionManagerSetResultV1Schema } from '../../../sessions/follow/sessionManagerV1.js';
import { projectPublicLinkCreationObservation } from '../artifacts.js';
import { SessionIdRequiredInputSchema } from '../common.js';
import type { PreNormalizedActionSpec } from '../definition.js';


function createSessionAccessActionSpecs() {
  const removePublicLinkSummary = 'Turn off a session\'s public link. People who have it can no longer open the session.';
  const createPublicLinkSummary = 'Make a link that lets anyone who has it read a session.';
  const teamContextSummary = 'Choose the Team a session is part of, which decides who sees it by default.';
  return Object.freeze([
  {
    id: 'session.access.grants.list', approval: {result: 'none'},
    title: 'List Session access',
    safety: 'safe',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'access', 'grants', 'list'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_access_grants_list' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'read',
    inputHints: { description: 'See who can open a session and what each of them may do.', fields: [] },
    inputSchema: SessionAccessGrantsListRequestV1Schema,
    outputSchema: SessionAccessGrantsListResponseV1Schema,
    serverTransport: { method: 'POST', path: '/v2/sessions/access-grants/list' },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.access.grant.set', approvalPolicy: { uiConfirmation: 'direct' }, approval: {result: 'optional',flow: 'deferred'},
    title: 'Set Session access',
    safety: 'danger',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'access', 'grant', 'set'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_access_grant_set' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'danger',
    inputHints: { description: 'Let a person or a Team open a session, and choose whether they may view, edit or manage it.', fields: [] },
    inputSchema: SessionAccessGrantSetActionInputV1Schema,
    outputSchema: SetSessionAccessGrantResponseV1Schema,
    serverTransport: { method: 'POST', path: '/v2/sessions/access-grants/set' },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.access.grant.remove', approvalPolicy: { uiConfirmation: 'direct' }, approval: {result: 'optional',flow: 'deferred'},
    title: 'Remove Session access',
    safety: 'danger',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'access', 'grant', 'remove'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_access_grant_remove' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'danger',
    inputHints: { description: 'Stop a person or a Team opening a session.', fields: [] },
    inputSchema: RemoveSessionAccessGrantRequestV1Schema,
    outputSchema: RemoveSessionAccessGrantResponseV1Schema,
    serverTransport: { method: 'POST', path: '/v2/sessions/access-grants/remove' },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.access.encryption.prepare', approvalPolicy: { uiConfirmation: 'direct' }, approval: { result: 'optional', flow: 'deferred' },
    title: 'Prepare encrypted Session access',
    safety: 'danger', sideEffectClass: 'danger', requiredAuthority: 'account_automation', executionPlacement: 'client',
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'access', 'encryption', 'prepare'], visibility: 'canonical' }] },
    placements: [], bindings: { mcpToolName: 'session_access_encryption_prepare' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { description: 'Prepare this Session’s existing encrypted audience on the answering client. This does not grant access.', fields: [] },
    inputSchema: SessionAccessEncryptionPrepareInputV1Schema, outputSchema: SessionAccessEncryptionPrepareResultV1Schema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.access.encryption.reprepare', approvalPolicy: { uiConfirmation: 'direct' }, approval: { result: 'optional', flow: 'deferred' },
    title: 'Re-prepare encrypted Session access for a person',
    safety: 'danger', sideEffectClass: 'danger', requiredAuthority: 'account_automation', executionPlacement: 'client',
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'access', 'encryption', 'reprepare'], visibility: 'canonical' }] },
    placements: [], bindings: { mcpToolName: 'session_access_encryption_reprepare' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { description: 'Re-seal this Session’s current key for one existing recipient on the answering client.', fields: [] },
    inputSchema: SessionAccessEncryptionReprepareInputV1Schema, outputSchema: SessionAccessEncryptionPrepareResultV1Schema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.access.layout.update', approvalPolicy: { uiConfirmation: 'policy' }, approval: { result: 'optional', flow: 'deferred' },
    confirmVerb: { key: 'common.update', fallback: 'Update' },
    title: 'Update historical Session sharing layout',
    safety: 'danger', sideEffectClass: 'danger', requiredAuthority: 'account_automation', executionPlacement: 'client',
    cli: { acceptsServerId: true, commands: [{ path: ['session', 'access', 'layout', 'update'], visibility: 'canonical' }] },
    placements: [], bindings: { mcpToolName: 'session_access_layout_update' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputHints: { description: 'Move an owned historical Session to the current owner/shared layout without changing its content. Requires the answering client’s keys.', fields: [] },
    inputSchema: SessionAccessEncryptionPrepareInputV1Schema, outputSchema: SessionAccessLayoutUpdateResultV1Schema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.access.context.set', approvalPolicy: { uiConfirmation: 'direct' }, approval: {result: 'optional',flow: 'deferred'},
    title: 'Set the Team a Session belongs to',
    safety: 'danger',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'access', 'context', 'set'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_access_context_set' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'danger',
    approvalPresentation: { summary: () => teamContextSummary },
    inputHints: { description: teamContextSummary, fields: [] },
    inputSchema: SetSessionAccessContextRequestV1Schema,
    outputSchema: SetSessionAccessContextResponseV1Schema,
    serverTransport: { method: 'POST', path: '/v2/sessions/access-context/set' },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.manager.set', approvalPolicy: { uiConfirmation: 'direct' }, approval: {result: 'optional',flow: 'deferred'},
    sessionTarget: { field: 'sessionId', cardinality: 'one' },
    title: 'Set Session manager',
    safety: 'danger',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'manager', 'set'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_manager_set', voiceClientToolName: 'session_manager_set' },
    examples: { voice: { argsExample: '{"sessionId":"{{sessionId}}","managerSessionId":"manager_session","expectedManagerSessionId":null}' } },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'danger',
    inputHints: { description: 'Choose which session manages this one, or let it stand on its own.', fields: [
      { path: 'sessionId', title: 'Session', prompt: 'Which session?', widget: 'text' },
      { path: 'managerSessionId', title: 'Manager session', description: 'Leave empty to detach it from its manager.', widget: 'text' },
      { path: 'expectedManagerSessionId', title: 'Expected current manager', widget: 'text' },
    ] },
    inputSchema: lazyZodSchema(() => z.extend(SessionManagerSetActionInputV1Schema, { sessionId: SessionTargetV1Schema })),
    outputSchema: SessionManagerSetResultV1Schema,
    serverTransport: { method: 'POST', path: '/v1/sessions/:sessionId/manager' },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.responsibility.set', approvalPolicy: { uiConfirmation: 'direct' }, approval: {result: 'optional',flow: 'deferred'},
    title: 'Assign Session to someone',
    safety: 'danger',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'responsibility', 'set'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_responsibility_set' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'danger',
    inputHints: { description: 'Choose who looks after a session and answers what it asks.', fields: [] },
    inputSchema: SetSessionResponsibilityRequestSchema,
    outputSchema: SetSessionResponsibilityResponseSchema,
    serverTransport: { method: 'POST', path: '/v2/sessions/responsibility/set' },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.responsibility.candidates.list', approval: {result: 'none'},
    title: 'Find who can take a Session',
    safety: 'safe',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'responsibility', 'candidates', 'list'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_responsibility_candidates_list' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'read',
    inputHints: { description: 'See the people a session can be assigned to.', fields: [] },
    inputSchema: SessionResponsibilityCandidatesRequestSchema,
    outputSchema: SessionResponsibilityCandidatesResponseSchema,
    serverTransport: { method: 'POST', path: '/v2/sessions/responsibility/candidates' },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.public_link.get', approval: {result: 'none'},
    title: 'Read Session public link',
    safety: 'safe',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'public-link', 'get'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_public_link_get' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'read',
    inputHints: { description: 'See whether a session has a public link and what the link allows.', fields: [] },
    inputSchema: lazyZodSchema(() => z.strictObject(SessionIdRequiredInputSchema.shape)),
    outputSchema: SessionPublicLinkGetActionResultV1Schema,
    serverTransport: { method: 'GET', path: '/v1/sessions/:sessionId/public-share' },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.public_link.create', approvalPolicy: { uiConfirmation: 'direct' }, approval: {result: 'optional',flow: 'deferred'},
    approvalNarrowing: {
      narrow(original, chosen) {
        const source = SessionPublicLinkCreateActionInputV1Schema.safeParse(original);
        const selection = SessionPublicLinkCreateActionInputV1Schema.safeParse(chosen);
        if (!source.success || !selection.success || selection.data.networkOff !== true) return null;
        const { networkOff: _originalOff, ...originalShare } = source.data;
        const { networkOff: _chosenOff, ...chosenShare } = selection.data;
        return sameStrictJsonValue(originalShare, chosenShare) ? selection.data : null;
      },
    },
    projectObservationOutput: projectPublicLinkCreationObservation,
    title: 'Create Session public link',
    safety: 'danger',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    executionPlacements: ['account', 'client'],
    executionPlacementForInput: (_input: unknown, caller?: Readonly<{ kind: string }>) =>
      caller?.kind === 'session' || caller?.kind === 'workflowRun' ? 'client' : 'account',
    cli: { commands: [{ path: ['session', 'public-link', 'create'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_public_link_create' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'danger',
    approvalPresentation: { summary: () => createPublicLinkSummary },
    inputHints: { description: createPublicLinkSummary, fields: [] },
    inputSchema: SessionPublicLinkCreateActionInputV1Schema,
    outputSchema: SessionPublicLinkCreateActionResultV1Schema,
    serverTransport: { method: 'POST', path: '/v1/public-shares' },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'session.public_link.remove', approval: {result: 'optional',flow: 'deferred'},
    irreversible: true,
    title: 'Remove Session public link',
    safety: 'danger',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'public-link', 'remove'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_public_link_remove' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'danger',
    approvalPresentation: { summary: () => removePublicLinkSummary },
    inputHints: { description: removePublicLinkSummary, fields: [] },
    inputSchema: SessionAccessGrantsListRequestV1Schema,
    outputSchema: SessionPublicLinkRemoveActionResultV1Schema,
    serverTransport: { method: 'DELETE', path: '/v1/sessions/:sessionId/public-share' },
  } satisfies PreNormalizedActionSpec,
] as const);
}

export const SESSION_ACCESS_ACTION_SPECS: ReturnType<typeof createSessionAccessActionSpecs> = lazyActionSpecArray(createSessionAccessActionSpecs);

