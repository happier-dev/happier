import {
  defineProtocolArray, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject,
  defineProtocolString, defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import { TriageSourceFailureV1Schema } from '@happier-dev/triage-protocol/v1';
import { advanceCursorCycleWalkV1, type CursorCycleWalkV1 } from '@happier-dev/triage-sources/runtime';
import type { SentryApiClientV1 } from '../api/sentryApiClient.js';
import { decodeSentryResponse } from '../api/sentryResponse.js';
import { readSentryNextPageRelation } from '../api/sentryLinkHeader.js';
import { buildSentryProjectPeopleUrl } from '../api/sentryRoutes.js';
import { isSentryNumericId, type SentryInvokedInstanceV1 } from '../instances/sentryCollisionScope.js';
import { SENTRY_FAILURE_CODES, type SentryFailureV1 } from '../sentryContracts.js';

export const SentryAssigneeV1Schema = defineProtocolObject({
  type: defineProtocolUnion([defineProtocolLiteral('user'), defineProtocolLiteral('team')]),
  id: defineProtocolString({ pattern: '^[0-9]+$' }),
  name: defineProtocolString({ minLength: 1 }).optional(),
  memberCount: defineProtocolNumber({ integer: true, minimum: 0 }).optional(),
}, { policy: 'closed' });
export type SentryAssigneeV1 = ReturnType<typeof SentryAssigneeV1Schema.parse>;

export const SentryIssueAssignmentProjectionV1Schema = defineProtocolObject({
  kind: defineProtocolLiteral('assignment'),
  assignee: defineProtocolUnion([SentryAssigneeV1Schema, defineProtocolLiteral(null)]).optional(),
  projectName: defineProtocolString({ minLength: 1 }).optional(),
  candidates: defineProtocolArray(SentryAssigneeV1Schema),
  failure: TriageSourceFailureV1Schema.optional(),
  omittedCandidateCount: defineProtocolNumber({ integer: true, minimum: 0 }),
}, { policy: 'closed' });
export type SentryIssueAssignmentProjectionV1 = ReturnType<typeof SentryIssueAssignmentProjectionV1Schema.parse>;

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nameOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Missing is unknown; only the provider's explicit null establishes Unassigned. */
export function readSentryAssignee(value: unknown): SentryAssigneeV1 | null | undefined {
  if (value === null) return null;
  if (!record(value) || (value.type !== 'user' && value.type !== 'team') || typeof value.id !== 'string' || !isSentryNumericId(value.id)) return undefined;
  const name = nameOf(value.name);
  return { type: value.type, id: value.id, ...(name === undefined ? {} : { name }) };
}

const unreadable: SentryFailureV1 = { class: 'unsupportedContract', code: SENTRY_FAILURE_CODES.responseUnparseable };

/**
 * Public API evidence (2026-11-07): projects/list-a-projects-organization-members and
 * teams/list-a-projects-teams. A member's assignment identity is user.id, never member.id.
 * Members is an unpaged list; teams follows Sentry's own cursor relation with no local cap.
 */
export async function readSentryIssueAssignment(
  client: SentryApiClientV1,
  input: Readonly<{ instance: SentryInvokedInstanceV1; body: Readonly<Record<string, unknown>>; nowMs: number }>,
): Promise<SentryIssueAssignmentProjectionV1> {
  const assignee = readSentryAssignee(input.body.assignedTo);
  const project = input.body.project;
  const projectName = record(project) ? nameOf(project.name) : undefined;
  const base = {
    kind: 'assignment' as const,
    ...(assignee === undefined ? {} : { assignee }),
    ...(projectName === undefined ? {} : { projectName }),
    omittedCandidateCount: 0,
  };
  if (!record(project) || typeof project.id !== 'string' || !isSentryNumericId(project.id)) return { ...base, candidates: [], failure: unreadable };
  const projectId = project.id;

  async function directory(kind: 'members' | 'teams'): Promise<Readonly<{ candidates: readonly SentryAssigneeV1[]; failure?: SentryFailureV1 }>> {
    const candidates: SentryAssigneeV1[] = [];
    let position: CursorCycleWalkV1 | null = null;
    const failure = (value: SentryFailureV1) => ({ candidates, failure: value });
    while (true) {
      const url = buildSentryProjectPeopleUrl({ instance: input.instance, projectId, kind,
        ...(position === null ? {} : { cursor: position.cursor }) });
      const operation = kind === 'members' ? 'projectMembers' : 'projectTeams';
      const outcome = await client.request({ url, operation });
      if (outcome.kind === 'failed') return failure(outcome.failure);
      const decoded = decodeSentryResponse(outcome.response, operation, input.nowMs);
      if (!decoded.ok) return failure(decoded.failure);
      if (!Array.isArray(decoded.body)) return failure(unreadable);
      for (const row of decoded.body) {
        if (!record(row)) return failure(unreadable);
        if (kind === 'members' && (row.user === null || row.pending === true)) continue;
        const person = kind === 'members' ? row.user : row;
        if (!record(person) || typeof person.id !== 'string' || !isSentryNumericId(person.id)) return failure(unreadable);
        const name = nameOf(person.name) ?? nameOf(kind === 'members' ? row.name : row.slug);
        if (name === undefined) return failure(unreadable);
        const memberCount = kind === 'teams' && typeof row.memberCount === 'number'
          && Number.isSafeInteger(row.memberCount) && row.memberCount >= 0 ? row.memberCount : undefined;
        candidates.push({ type: kind === 'members' ? 'user' : 'team', id: person.id, name,
          ...(memberCount === undefined ? {} : { memberCount }) });
      }
      const next = readSentryNextPageRelation(outcome.response.headers);
      if (next.kind === 'exhausted' || (kind === 'members' && next.kind === 'headerAbsent')) return { candidates };
      if (next.kind === 'headerAbsent') return failure({ class: 'unsupportedContract', code: SENTRY_FAILURE_CODES.paginationHeaderAbsent });
      if (next.kind === 'unusable') return failure({ class: 'unsupportedContract', code: SENTRY_FAILURE_CODES.paginationCursorMalformed });
      let nextUrl: URL;
      try { nextUrl = new URL(next.url); } catch { return failure(unreadable); }
      if (nextUrl.pathname !== new URL(url).pathname) return failure({ class: 'unsupportedContract', code: SENTRY_FAILURE_CODES.paginationCursorMalformed });
      const advanced = advanceCursorCycleWalkV1(position, next.cursor);
      if (advanced.kind === 'revisited') return failure({ class: 'unsupportedContract', code: SENTRY_FAILURE_CODES.paginationCursorNotAdvancing });
      position = advanced.walk;
    }
  }

  const [members, teams] = await Promise.all([directory('members'), directory('teams')]);
  const failure = members.failure ?? teams.failure;
  return { ...base, candidates: [...members.candidates, ...teams.candidates], ...(failure === undefined ? {} : { failure }) };
}
