import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1 } from '../approvals/approvalArtifactKindV1.js';
import type { ArtifactListSelectionOptionsV1 } from '../artifacts/artifactListSelectionV1.js';
import type { ArtifactSharingResourceV1 } from '../artifacts/artifactSharingV1.js';
import type { ArtifactRevisionV1 } from '../artifacts/artifactRevisionV1.js';
import { ActionSurfaceSchema } from './metadata.js';
import {
  ActionApprovalScopeV1Schema,
  actionScopedApprovalPreferenceKey,
  normalizeActionSettingsActionId,
  setActionApprovalOverride,
  setScopedActionApprovalPreference,
  type ActionApprovalScopeV1,
  type ActionsSettingsV1,
  type ActionSurfaceKey,
} from './actionSettings.js';
export { SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1 } from '../approvals/approvalArtifactKindV1.js';

/**
 * "Allow for this Session": two rungs on the existing approval-preference ladder (this Action in
 * this Session; this Action on one Machine or Environment in this Session). One private Account
 * Artifact per Session holds the person's rows; the server binds it to the Session it owns.
 */
export const SessionApprovalConsentModeV1Schema = lazyZodSchema(() =>
  z.enum(['allowed', 'ask_first']),
);
export const SessionApprovalConsentRowV1Schema = lazyZodSchema(() =>
  z.strictObject({
    actionId: z
      .string()
      .check(
        z.refine((value) => normalizeActionSettingsActionId(value) === value),
      ),
    audience: z.keyof(ActionSurfaceSchema),
    scope: z.optional(ActionApprovalScopeV1Schema),
    mode: SessionApprovalConsentModeV1Schema,
  }),
);
export type SessionApprovalConsentRowV1 = z.infer<
  typeof SessionApprovalConsentRowV1Schema
>;
const SessionApprovalConsentsArtifactV1Schema = lazyZodSchema(() =>
  z.strictObject({
    v: z.literal(1),
    kind: z.literal(SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1),
    sessionId: z.string().check(z.minLength(1)),
    rows: z.array(z.unknown()),
  }),
);

/** One host-bound lookup for the caller's own Session; never caller input. */
export type BoundSessionApprovalConsentsV1 = Readonly<{
  sessionId: string;
  rows: readonly SessionApprovalConsentRowV1[];
}>;
export type ReadableSessionApprovalConsentsV1 = BoundSessionApprovalConsentsV1 &
  Readonly<{
    artifactId: string;
    revision: ArtifactRevisionV1;
  }>;

export function buildSessionApprovalConsentsHeaderV1(
  sessionId: string,
): Readonly<Record<string, unknown>> {
  return { kind: SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1, sessionId };
}

/** Strict reader: a row that does not parse is dropped, so its Action asks. */
export function readSessionApprovalConsentsArtifactV1(
  resource: ArtifactSharingResourceV1,
  sessionId: string,
): ReadableSessionApprovalConsentsV1 | null {
  if (
    resource.header.kind !== SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1 ||
    resource.header.sessionId !== sessionId ||
    (resource.access !== undefined && resource.access !== 'owner') ||
    typeof resource.body !== 'string'
  )
    return null;
  const revision =
    resource.revision ??
    (resource.headerVersion !== undefined &&
    'bodyVersion' in resource &&
    typeof resource.bodyVersion === 'number'
      ? {
          headerVersion: resource.headerVersion,
          bodyVersion: resource.bodyVersion,
        }
      : undefined);
  if (!revision) return null;
  let parsed: z.infer<typeof SessionApprovalConsentsArtifactV1Schema>;
  try {
    const result = SessionApprovalConsentsArtifactV1Schema.safeParse(
      JSON.parse(resource.body),
    );
    if (!result.success || result.data.sessionId !== sessionId) return null;
    parsed = result.data;
  } catch {
    return null;
  }
  const rows = parsed.rows.flatMap((raw) => {
    const row = SessionApprovalConsentRowV1Schema.safeParse(raw);
    return row.success ? [row.data] : [];
  });
  return { artifactId: resource.artifactId, revision, sessionId, rows };
}

function rowKey(
  row: Pick<SessionApprovalConsentRowV1, 'actionId' | 'audience' | 'scope'>,
): string {
  return JSON.stringify([
    row.audience,
    row.scope
      ? actionScopedApprovalPreferenceKey(row.actionId, row.scope)
      : row.actionId,
  ]);
}

export type SessionApprovalConsentModeChangeV1 = Readonly<{
  actionId: string;
  audience: ActionSurfaceKey;
  scope?: ActionApprovalScopeV1;
  mode: 'allowed' | 'ask_first' | 'default';
}>;

/** One row edit; `default` removes the row so the Account and profile answer again. */
export function setSessionApprovalConsentRowV1(
  rows: readonly SessionApprovalConsentRowV1[],
  change: SessionApprovalConsentModeChangeV1,
): readonly SessionApprovalConsentRowV1[] {
  const key = rowKey(change);
  const others = rows.filter((row) => rowKey(row) !== key);
  if (change.mode === 'default') return others;
  return [
    ...others,
    {
      actionId: change.actionId,
      audience: change.audience,
      ...(change.scope ? { scope: change.scope } : {}),
      mode: change.mode,
    },
  ];
}

export function readSessionApprovalConsentModeV1(
  rows: readonly SessionApprovalConsentRowV1[],
  target: Pick<SessionApprovalConsentRowV1, 'actionId' | 'audience' | 'scope'>,
): 'allowed' | 'ask_first' | 'default' {
  const key = rowKey(target);
  return rows.find((row) => rowKey(row) === key)?.mode ?? 'default';
}

/**
 * Materialize the Session rows onto the policy view through the ladder's own writers. A Session
 * Action row replaces the view's Action answer for its audience, including narrower Account or
 * profile rows for that Action; a Session resource row is applied last, so it is the most specific.
 */
export function applySessionApprovalConsentsV1(
  settings: ActionsSettingsV1,
  consents: BoundSessionApprovalConsentsV1 | null | undefined,
): ActionsSettingsV1 {
  // Rows for Actions the policy owner decides elsewhere stay inert here: approval controls never
  // ask, approval-rule changes are decided on Account settings (Q6), and the capture waiver ignores
  // Action-wide waivers. Writers refuse them up front (sessionApprovalConsentPolicyV1).
  const rows = consents?.rows ?? [];
  if (rows.length === 0) return settings;
  let next = settings;
  for (const row of rows) {
    if (row.scope) continue;
    next = setActionApprovalOverride({
      settings: next,
      actionId: row.actionId as Parameters<
        typeof setActionApprovalOverride
      >[0]['actionId'],
      surface: row.audience,
      approvalRequired: row.mode === 'ask_first',
    });
    for (const scoped of next.scopedApprovalPreferences ?? []) {
      if (scoped.actionId !== row.actionId) continue;
      next = setScopedActionApprovalPreference({
        settings: next,
        actionId: scoped.actionId,
        scope: scoped.scope,
        surface: row.audience,
        mode: 'inherit',
      });
    }
  }
  for (const row of rows) {
    if (!row.scope) continue;
    next = setScopedActionApprovalPreference({
      settings: next,
      actionId: row.actionId,
      scope: row.scope,
      surface: row.audience,
      mode: row.mode === 'ask_first' ? 'required' : 'waived',
    });
  }
  return next;
}

export type SessionApprovalConsentFailureV1 = Readonly<{ ok: false; errorCode: string; error: string }>;
type Failure = SessionApprovalConsentFailureV1;

/** The Artifact transport retains access, encryption and the server's Session binding gate. */
export type SessionApprovalConsentsStoreV1 = Readonly<{
  list: (options: ArtifactListSelectionOptionsV1) => Promise<
    Readonly<{
      items: readonly (ArtifactSharingResourceV1 & { bodyVersion?: number })[];
      nextCursor?: string;
    }>
  >;
  create: (
    input: Readonly<{
      header: Readonly<Record<string, unknown>>;
      body: string;
      signal?: AbortSignal;
    }>,
  ) => Promise<Readonly<{ artifactId: string; revision: ArtifactRevisionV1 }>>;
  update: (
    input: Readonly<{
      artifactId: string;
      expectedRevision: ArtifactRevisionV1;
      header: Readonly<{ [key: string]: unknown }>;
      body: string;
      signal?: AbortSignal;
    }>,
  ) => Promise<Readonly<{ ok: true; revision: ArtifactRevisionV1 }> | Failure>;
}>;

/** The Session's record; with several (a lost create race) the lowest id is the one read and written. */
export async function loadSessionApprovalConsentsV1(
  store: Pick<SessionApprovalConsentsStoreV1, 'list'>,
  sessionId: string,
  signal?: AbortSignal,
): Promise<ReadableSessionApprovalConsentsV1 | null> {
  const found: ReadableSessionApprovalConsentsV1[] = [];
  let cursor: string | undefined;
  do {
    signal?.throwIfAborted();
    const page = await store.list({
      kinds: [SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1],
      approvalSessionIds: [sessionId],
      includeBody: true,
      cursor,
      signal,
    });
    for (const item of page.items) {
      const readable = readSessionApprovalConsentsArtifactV1(item, sessionId);
      if (readable) found.push(readable);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return (
    found.sort((left, right) =>
      left.artifactId < right.artifactId
        ? -1
        : left.artifactId > right.artifactId
          ? 1
          : 0,
    )[0] ?? null
  );
}

export function serializeSessionApprovalConsentsBodyV1(
  sessionId: string,
  rows: readonly SessionApprovalConsentRowV1[],
): string {
  return JSON.stringify({
    v: 1,
    kind: SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1,
    sessionId,
    rows,
  });
}
