import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { deriveBoxPublicKeyFromSeed } from '@happier-dev/protocol/crypto/boxBundle';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { EmbedCredentialInputV1Schema, EmbedCredentialRequestV1Schema } from '@happier-dev/protocol/embed';
import { actionSchemas } from './leads-fixture/contracts.mjs';

/** The fixture owns both endpoints, so every frame must select the same Home as its server SDK. */
export function buildFixtureHappierUrl(happierUrl, serverUrl) {
  const url = new URL(happierUrl);
  url.searchParams.set('server', serverUrl);
  return url.href;
}

export function matchFixtureLiveRoute(method, path) {
  const match = method === 'GET'
    ? /^\/live\/([^/]+)$/.exec(path)
    : method === 'POST' ? /^\/api\/live\/([^/]+)\/credential$/.exec(path) : null;
  if (!match) return null;
  try {
    const leadId = decodeURIComponent(match[1]);
    if (!/^[A-Za-z0-9_-]+$/.test(leadId)) return null;
    return { kind: method === 'GET' ? 'page' : 'credential', leadId };
  } catch {
    return null;
  }
}

/** The browser receives only a short-lived child bearer; the parent and sealed embed fields stay server-side. */
export async function createLivePageBootstrap({ endpoint, issuer, store, userId, leadId }) {
  const lead = store.listLeads(userId).find((entry) => entry.id === leadId);
  if (!lead) throw new Error('lead_forbidden');
  if (!lead.sessionId) throw new Error('lead_session_required');
  const seed = randomBytes(32);
  try {
    const embedPublicKey = encodeBase64(deriveBoxPublicKeyFromSeed(seed), 'base64url');
    const credential = EmbedCredentialInputV1Schema.parse(await issuer.issue(userId, {
      sessionId: lead.sessionId,
      embedPublicKey,
      reason: 'open',
    }));
    return { endpoint, sessionId: lead.sessionId, token: credential.token };
  } finally {
    seed.fill(0);
  }
}

/** CRM records are dev-only memory; host reloads retain them, server restarts reset them. */
export function createFixtureStore() {
  const requestNamespace = randomUUID();
  const leads = [
    { id: 'northstar', name: 'Northstar Labs', contact: 'Maya · Head of operations', ownerId: 'salesperson',
      notes: 'A 40-person research team wants to reduce manual inbound triage. Maya owns evaluation; budget review is next Tuesday.' },
    { id: 'verdant', name: 'Verdant Supply', contact: 'Luis · Commercial lead', ownerId: 'salesperson',
      notes: 'A regional supplier needs faster follow-up on distributor enquiries. Luis asked for an example workflow and clear pricing.' },
    { id: 'alpine', name: 'Alpine Studio', contact: 'Sam · Founder', ownerId: 'other-salesperson',
      notes: 'A design studio is exploring a lightweight pipeline. Sam is still comparing approaches and has no decision date.' },
  ].map((lead) => ({ ...lead, analysis: null, stage: 'new', stageUpdates: 0, sessionId: null }));
  const sessionOwners = new Map();
  const copilots = new Map();
  const invocations = new Map();
  const claim = (userId, sessionId) => {
    const incumbent = sessionOwners.get(sessionId);
    if (incumbent && incumbent !== userId) throw new Error('session_forbidden');
    sessionOwners.set(sessionId, userId);
  };
  return {
    listLeads: (userId) => structuredClone(leads.filter((lead) => lead.ownerId === userId)),
    canOpenSession: (userId, sessionId) => sessionOwners.get(sessionId) === userId,
    copilotSessionId: (userId) => copilots.get(userId) ?? null,
    leadCreationRequestId: (userId, leadId) => `fixture-lead-${requestNamespace}-${userId}-${leadId}`,
    attachLeadSession(userId, leadId, sessionId) {
      const lead = leads.find((entry) => entry.id === leadId && entry.ownerId === userId);
      if (!lead) throw new Error('lead_forbidden');
      claim(userId, sessionId);
      lead.sessionId = sessionId;
    },
    claimCopilot(userId, sessionId) {
      claim(userId, sessionId);
      copilots.set(userId, sessionId);
    },
    apply(action, input, idempotencyKey, sessionId) {
      if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) throw new Error('idempotency_key_required');
      if (!Object.hasOwn(actionSchemas, action)) throw new Error('action_not_found');
      const parsed = actionSchemas[action].parse(input);
      const ownerId = sessionOwners.get(sessionId);
      if (!ownerId) throw new Error('session_forbidden');
      const lead = leads.find((entry) => entry.id === parsed.leadId);
      if (!lead) throw new Error('lead_not_found');
      if (lead.ownerId !== ownerId) throw new Error('lead_forbidden');
      const previous = invocations.get(idempotencyKey);
      if (previous) {
        if (previous.action !== action || !isDeepStrictEqual(previous.input, parsed)) throw new Error('idempotency_conflict');
        return structuredClone(previous.result);
      }
      if (action === 'record_analysis') {
        lead.analysis = { score: parsed.score, summary: parsed.summary, nextStep: parsed.nextStep };
      } else {
        lead.stage = parsed.stage;
        lead.stageUpdates += 1;
      }
      const result = { leadId: lead.id, invocationId: idempotencyKey };
      invocations.set(idempotencyKey, { action, input: parsed, result });
      return structuredClone(result);
    },
  };
}

function readTypedSdkErrorCode(error) {
  if (!error || typeof error !== 'object') return null;
  if (typeof error.code === 'string' && error.code.trim()) return error.code;
  if (typeof error.result?.code === 'string' && error.result.code.trim()) return error.result.code;
  const initialInput = error.result?.initialInput;
  return initialInput && typeof initialInput.code === 'string' && initialInput.code.trim()
    ? initialInput.code : null;
}

function readRetainedSdkSessionId(error) {
  if (!error || typeof error !== 'object') return undefined;
  if (typeof error.session?.id === 'string' && error.session.id.trim()) return error.session.id;
  return typeof error.result?.sessionId === 'string' && error.result.sessionId.trim()
    ? error.result.sessionId : undefined;
}

function readTypedSdkIssues(error) {
  if (!error || typeof error !== 'object' || !error.details || typeof error.details !== 'object'
    || !Array.isArray(error.details.issues)) return [];
  return error.details.issues.flatMap((issue) => {
    if (!issue || typeof issue !== 'object' || typeof issue.code !== 'string' || !issue.code.trim()
      || !Array.isArray(issue.path) || issue.path.some((segment) => typeof segment !== 'string' && typeof segment !== 'number')) {
      return [];
    }
    return [{ path: issue.path, code: issue.code }];
  });
}

const GRANT_DENIAL_REASONS = new Set([
  'action_not_granted',
  'target_required',
  'target_not_granted',
  'create_not_granted',
  'automation_not_granted',
]);

function readCredentialScopeDiagnostic(error) {
  if (!error || typeof error !== 'object') return null;
  const candidate = error.diagnostic ?? error.details;
  return candidate && typeof candidate === 'object'
    && candidate.admissionStage === 'execution_authorization'
    && GRANT_DENIAL_REASONS.has(candidate.grantReason)
    ? { admissionStage: candidate.admissionStage, grantReason: candidate.grantReason }
    : null;
}

function fixtureSdkFailure(error, sessionId) {
  const code = readTypedSdkErrorCode(error) ?? 'fixture_sdk_error';
  const issues = readTypedSdkIssues(error);
  const diagnostic = readCredentialScopeDiagnostic(error);
  const failure = Object.assign(new Error(code), {
    code,
    sessionId,
    ...(issues.length ? { details: issues } : {}),
    ...(diagnostic ? { diagnostic } : {}),
  });
  if (error && typeof error === 'object' && typeof error.status === 'number') failure.status = error.status;
  return failure;
}

/** Content-free HTTP projection; typed SDK failures never expose exception text. */
export function projectFixtureErrorResponse(error) {
  const code = error && typeof error === 'object' && typeof error.code === 'string' && error.code.trim()
    ? error.code : error instanceof Error ? error.message : 'fixture_error';
  const status = error && typeof error === 'object' && typeof error.status === 'number'
    ? error.status : code === 'session_forbidden' || code === 'lead_forbidden' ? 403
      : code === 'idempotency_conflict' ? 409 : 400;
  const sessionId = error && typeof error === 'object' && typeof error.sessionId === 'string' && error.sessionId.trim()
    ? error.sessionId : null;
  const issues = error && typeof error === 'object' && Array.isArray(error.details)
    ? error.details.flatMap((issue) => {
      if (!issue || typeof issue !== 'object' || typeof issue.code !== 'string' || !issue.code.trim()
        || !Array.isArray(issue.path) || issue.path.some((segment) => typeof segment !== 'string' && typeof segment !== 'number')) {
        return [];
      }
      return [{ path: issue.path, code: issue.code }];
    }) : [];
  return { status, body: { error: code, ...(sessionId ? { sessionId } : {}), ...(issues.length ? { issues } : {}) } };
}

/** Log projection never falls back to an exception message or schema issue values. */
export function projectFixtureErrorLog(error) {
  const response = projectFixtureErrorResponse(error);
  const diagnostic = readCredentialScopeDiagnostic(error);
  const errorCode = error && typeof error === 'object' && typeof error.code === 'string' && error.code.trim()
    ? error.code : 'fixture_error';
  return {
    status: response.status,
    error: errorCode,
    ...(response.body.sessionId ? { sessionId: response.body.sessionId } : {}),
    ...(response.body.issues ? { issues: response.body.issues } : {}),
    ...(diagnostic ? { diagnostic } : {}),
  };
}

/** Claim CRM ownership before the agent can call the business Actions in its first turn. */
export async function createLeadChat({ happier, store, userId, leadId }) {
  const lead = store.listLeads(userId).find((entry) => entry.id === leadId);
  if (!lead) throw new Error('lead_forbidden');
  let session;
  if (lead.sessionId) {
    session = happier.sessions.get(lead.sessionId);
  } else {
    try {
      session = await happier.embed.createSession({ title: lead.name }, { requestId: store.leadCreationRequestId(userId, lead.id) });
    } catch (error) {
      throw fixtureSdkFailure(error, readRetainedSdkSessionId(error));
    }
  }
  store.attachLeadSession(userId, lead.id, session.id);
  let result;
  try {
    result = await session.send(
      `Analyze this lead. Call the dev.leads-fixture/actions/record-analysis Action with leadId=${lead.id}, score (0-100), summary and nextStep.\n${lead.notes}`,
      { requestId: `fixture-analysis-${userId}-${lead.id}` },
    );
  } catch (error) {
    throw fixtureSdkFailure(error, session.id);
  }
  if (result.status !== 'accepted' && result.status !== 'alreadyAccepted' && result.status !== 'outcomeUnknown') {
    throw fixtureSdkFailure(result, session.id);
  }
  return session.id;
}

/** Generated-snippet credential flow with the CRM's user/session authorization rule. */
export function createCredentialIssuer({ embed, store, expiresInSeconds = 900 }) {
  const newChatIssuedTo = new Map();
  return {
    async issue(userId, input) {
      const request = EmbedCredentialRequestV1Schema.parse({ ...input, kind: 'credential.request' });
      for (const [tokenId, issued] of newChatIssuedTo) {
        if (issued.expiresAt <= Date.now()) newChatIssuedTo.delete(tokenId);
      }
      const { sessionId, embedPublicKey, reason, createdByTokenId } = request;
      if (!sessionId) {
        const credential = await embed.createCredential({ embedPublicKey, expiresInSeconds });
        newChatIssuedTo.set(credential.tokenId, { userId, expiresAt: Date.parse(credential.expiresAt) });
        return credential;
      }
      if (reason === 'created') {
        if (newChatIssuedTo.get(createdByTokenId)?.userId !== userId) throw new Error('session_forbidden');
        const credential = await embed.createCredential({
          sessionId, embedPublicKey, expiresInSeconds, requireCreatedBy: createdByTokenId,
        });
        // Mint is the server-verified creation proof. The callback's session id alone grants nothing.
        store.claimCopilot(userId, sessionId);
        // Keep the issuance record until its child expires, so failed admission can retry the exchange.
        return credential;
      }
      if (!store.canOpenSession(userId, sessionId)) throw new Error('session_forbidden');
      return embed.createCredential({ sessionId, embedPublicKey, expiresInSeconds });
    },
  };
}
