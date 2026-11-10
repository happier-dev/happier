import { lazyActionSpecArray } from '../../lazyActionSpecValue.js';
import { z } from '../../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import {
  SessionAccessCandidatesInspectRequestV1Schema, SessionAccessCandidatesInspectResponseV1Schema,
  ResolveSessionAccessPrincipalsRequestV1Schema, ResolveSessionAccessPrincipalsResponseV1Schema,
} from '../../../sessions/access/sessionAccessOperationsV1.js';
import { UsersSearchQueryV1Schema, UsersSearchResponseSchema } from '../../../social/friends.js';
import type { PreNormalizedActionSpec } from '../../actionSpecs.js';

function createSessionAccessDiscoveryActionSpecsV1() {
  return Object.freeze([
  {
    id: 'session.access.candidates.inspect', approval: {result: 'none'},
    title: 'Inspect Session access candidates',
    safety: 'safe',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'access', 'candidates', 'inspect'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_access_candidates_inspect' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'read',
    inputHints: { description: 'Preview which recipients the current Team policy admits. The grant writer rechecks every decision.', fields: [] },
    inputSchema: SessionAccessCandidatesInspectRequestV1Schema,
    outputSchema: SessionAccessCandidatesInspectResponseV1Schema,
    serverTransport: { method: 'POST', path: '/v2/sessions/access-candidates/inspect' },
  },
  {
    id: 'session.access.principals.resolve', approval: {result: 'none'},
    title: 'Resolve Session access recipients',
    safety: 'safe',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'access', 'principals', 'resolve'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_access_principals_resolve' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'read',
    inputHints: { description: 'Resolve visible recipient labels and, optionally, the Team decision for creating a Session.', fields: [] },
    inputSchema: ResolveSessionAccessPrincipalsRequestV1Schema,
    outputSchema: ResolveSessionAccessPrincipalsResponseV1Schema,
    serverTransport: { method: 'POST', path: '/v1/session-access/principals/resolve' },
  },
  {
    id: 'session.access.accounts.search', approval: {result: 'none'},
    title: 'Find Session access recipients',
    safety: 'safe',
    requiredAuthority: 'account_automation',
    executionPlacement: 'account',
    cli: { commands: [{ path: ['session', 'access', 'accounts', 'search'], visibility: 'canonical' }] },
    placements: [],
    bindings: { mcpToolName: 'session_access_accounts_search' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    sideEffectClass: 'read',
    inputHints: { description: 'Search the collaboration directory for people who may receive Session access, carrying its opaque continuation unchanged.', fields: [] },
    inputSchema: lazyZodSchema(() => z.extend(UsersSearchQueryV1Schema, { purpose: z.literal('collaboration') })),
    outputSchema: UsersSearchResponseSchema,
    serverTransport: { method: 'GET', path: '/v1/user/search' },
  },
] as const satisfies readonly PreNormalizedActionSpec[]);
}

export const SESSION_ACCESS_DISCOVERY_ACTION_SPECS_V1: ReturnType<typeof createSessionAccessDiscoveryActionSpecsV1> = lazyActionSpecArray(createSessionAccessDiscoveryActionSpecsV1);
