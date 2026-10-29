import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { projectSessionSectionV1, compareSessionSectionOrderV1, resolveSessionSectionCreatePlacementV1, SessionSectionV1Schema, SessionSectionDisplayV1Schema,
  type SessionFolderAssignment, type SessionOrganizationFolder, type SessionOrganizationOpenedDisplayStateV1 } from '../sessions/organization/folders.js';
import { CreateOrUpdateSessionOrganizationFolderRequestSchema, DeleteSessionOrganizationFolderRequestSchema,
  SetSessionFolderAssignmentRequestSchema, type CreateOrUpdateSessionOrganizationFolderRequest,
  type DeleteSessionOrganizationFolderRequest, type DeleteSessionOrganizationFolderResponse,
  type SetSessionFolderAssignmentResponse } from '../sessions/organization/mutations.js';
import { SessionOrganizationSnapshotRequestSchema, sessionOrganizationSnapshotRequestFromQueryV1,
  type SessionOrganizationSnapshotRequest } from '../sessions/organization/snapshot.js';
import { pluginJsonValuesEqual } from '../plugins/contributions/jsonSchemaValues.js';
import { SessionSectionRefV1Schema } from './sessionSectionArchive.js';
export { SessionSectionRefV1Schema, readSessionSectionArchiveStopTargetV1, isSessionSectionArchiveStopChildV1 } from './sessionSectionArchive.js';
import { SessionArchiveActionResultV1Schema } from '../sessions/control/contract.js';
import { readActionFailureEnvelope } from './executor/actionFailureEnvelope.js';
import { isActionOutcomeUnknownErrorCodeV1, projectUnexpectedActionFailureV1, type ActionExecuteFailure, type ActionExecuteResult } from './actionExecutionResult.js';

const id = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
export const SessionSectionsCreateInputV1Schema = lazyZodSchema(() => z.strictObject({
  name: SessionSectionDisplayV1Schema.shape.name, icon: z.optional(SessionSectionDisplayV1Schema.shape.icon),
}));
export const SessionSectionsUpdateInputV1Schema = lazyZodSchema(() => z.strictObject({
  sectionId: id, name: z.optional(SessionSectionDisplayV1Schema.shape.name), icon: z.optional(SessionSectionDisplayV1Schema.shape.icon),
}).check(z.refine(value => value.name !== undefined || value.icon !== undefined, 'Provide a name or icon')));
export const SessionSectionsReorderInputV1Schema = lazyZodSchema(() => z.strictObject({ sectionId: id, beforeSectionId: z.nullable(id) }));
export const SessionSectionSetInputV1Schema = lazyZodSchema(() => z.strictObject({ sessionId: id, sectionId: z.nullable(id) }));
export const SessionSectionSetResultV1Schema = lazyZodSchema(() => z.strictObject({ sessionId: id, sectionId: z.nullable(id), previousSectionId: z.nullable(id) }));
export const SessionSectionsListResultV1Schema = lazyZodSchema(() => z.strictObject({ sections: z.array(SessionSectionV1Schema) }));
export const SessionSectionResultV1Schema = lazyZodSchema(() => z.strictObject({ section: SessionSectionV1Schema }));
export const SessionSectionsReorderResultV1Schema = lazyZodSchema(() => z.strictObject({ sectionId: id, sortKey: SessionSectionV1Schema.shape.sortKey }));
export const SessionSectionsDeleteResultV1Schema = lazyZodSchema(() => z.strictObject({ sectionId: id, removed: z.boolean(), affectedAssignmentCount: z.number().check(z.int(), z.nonnegative()) }));
export const SessionSectionsArchiveResultV1Schema = lazyZodSchema(() => z.strictObject({
  archivedSessionIds: z.array(id), failures: z.array(z.strictObject({ sessionId: id, code: z.string() })), unknownSessionIds: z.array(id),
}));

export type SessionSectionFolderV1 = Omit<SessionOrganizationFolder, 'displayState'> & Readonly<{ displayState: SessionOrganizationOpenedDisplayStateV1 }>;
export type SessionSectionActionIdV1 = 'session.sections.list' | 'session.sections.create' | 'session.sections.update'
  | 'session.sections.reorder' | 'session.sections.delete' | 'session.sections.archive' | 'session.section.set';
export function isSessionSectionActionIdV1(actionId: string): actionId is SessionSectionActionIdV1 {
  return actionId === 'session.section.set' || actionId === 'session.sections.list' || actionId === 'session.sections.create'
    || actionId === 'session.sections.update' || actionId === 'session.sections.reorder' || actionId === 'session.sections.delete' || actionId === 'session.sections.archive';
}

/** Only the ordinary archive and its incumbent active-Session Stop may derive from Archive all. */
export function isSessionSectionArchiveEffectV1(rootActionId: string, effectActionId: string): boolean {
  return rootActionId === 'session.sections.archive' && (effectActionId === 'session.archive' || effectActionId === 'session.stop');
}

/** Signed transport grammar, not a second semantic input parser or a resource grant. */
export function readSessionSectionActionHttpPurposeV1(actionId: SessionSectionActionIdV1, request: Readonly<{
  method: string; path: string; body?: unknown; routeInput?: unknown; sessionRouteSessionId?: string;
}>): Readonly<{ sessionIds: readonly string[] }> | null {
  const method = request.method.toUpperCase();
  const matchesRoute = (input: unknown) => request.routeInput === undefined || pluginJsonValuesEqual(request.routeInput, input);
  const url = new URL(request.path, 'http://home.invalid');
  if (request.path !== `${url.pathname}${url.search}` || url.hash) return null;
  if (method === 'GET' && url.pathname === '/v2/session-organization' && request.body === undefined) {
    const query = Object.fromEntries(url.searchParams);
    if (Object.keys(query).length !== [...url.searchParams].length
      || Object.keys(query).some(key => !Object.hasOwn(SessionOrganizationSnapshotRequestSchema.shape, key))
      || !matchesRoute(query) || request.sessionRouteSessionId !== undefined) return null;
    const parsed = SessionOrganizationSnapshotRequestSchema.safeParse(sessionOrganizationSnapshotRequestFromQueryV1(query));
    if (!parsed.success) return null;
    const value = parsed.data;
    if (value.includeTags || value.includeLabels || value.includeAllFolderAssignments || value.includeAllTagAssignments
      || value.includeAttentionStandings || value.includeAttentionReminderTimes || value.tagIds.length || value.orderScopes.length) return null;
    const assignment = actionId === 'session.section.set';
    const named = actionId === 'session.sections.update' || actionId === 'session.sections.archive';
    if (actionId === 'session.sections.delete' || value.includeFolders !== !assignment
      || value.assignmentSessionIds.length !== (assignment ? 1 : 0) || value.folderIds.length !== (named ? 1 : 0)) return null;
    return { sessionIds: value.assignmentSessionIds };
  }
  if (method === 'POST' && request.path === '/v2/session-organization/folders'
    && ['session.sections.create', 'session.sections.update', 'session.sections.reorder'].includes(actionId)) {
    const parsed = CreateOrUpdateSessionOrganizationFolderRequestSchema.safeParse(request.body);
    return parsed.success && matchesRoute(request.body) && request.sessionRouteSessionId === undefined ? { sessionIds: [] } : null;
  }
  if (actionId === 'session.sections.delete' && method === 'DELETE') {
    const parsed = DeleteSessionOrganizationFolderRequestSchema.safeParse(request.body);
    return parsed.success && request.path === `/v2/session-organization/folders/${encodeURIComponent(parsed.data.folderId)}`
      && matchesRoute(parsed.data)
      && request.sessionRouteSessionId === undefined ? { sessionIds: [] } : null;
  }
  if (actionId === 'session.section.set' && method === 'PUT' && request.sessionRouteSessionId) {
    const parsed = SetSessionFolderAssignmentRequestSchema.safeParse(request.body);
    const sessionId = request.sessionRouteSessionId;
    return parsed.success && request.path === `/v2/session-organization/folder-assignments/${encodeURIComponent(sessionId)}`
      && matchesRoute({ sessionId, ...parsed.data }) ? { sessionIds: [sessionId] } : null;
  }
  return null;
}

/** Hosts retain Account custody, encryption, persistence and ordinary archive admission. */
export type SessionSectionActionPortV1 = Readonly<{
  assertCurrent(): void | Promise<void>;
  allocateFolderId(): string;
  /** Named assignment reads are complete: unknown projection coverage must use the exact query. */
  readSnapshot(request: Partial<SessionOrganizationSnapshotRequest>): Promise<Readonly<{
    folders: readonly SessionSectionFolderV1[]; folderAssignments: readonly SessionFolderAssignment[];
  }> | ActionExecuteFailure>;
  upsertFolder(request: CreateOrUpdateSessionOrganizationFolderRequest): Promise<SessionSectionFolderV1 | ActionExecuteFailure>;
  deleteFolder(request: DeleteSessionOrganizationFolderRequest): Promise<DeleteSessionOrganizationFolderResponse | ActionExecuteFailure>;
  setAssignment(sessionId: string, folderId: string | null): Promise<SetSessionFolderAssignmentResponse | ActionExecuteFailure>;
  archiveSession?: (sessionId: string) => Promise<ActionExecuteResult>;
}>;
const fail = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
const definitionsRequest = { includeFolders: true, includeTags: false, includeLabels: false } as const;
function compareFolders(a: SessionSectionFolderV1, b: SessionSectionFolderV1): number {
  return compareSessionSectionOrderV1({ sectionId: a.folderId, sortKey: a.sortKey }, { sectionId: b.folderId, sortKey: b.sortKey });
}
function folderRequest(folder: SessionSectionFolderV1, sortKey = folder.sortKey): CreateOrUpdateSessionOrganizationFolderRequest {
  return { folderId: folder.folderId, folderKey: folder.folderKey, parentFolderId: folder.parentFolderId,
    parentFolderKey: folder.parentFolderKey, sortKey, display: folder.display };
}

/** One semantic owner for UI, CLI and plugin callers; physical DTO names stay at this seam. */
export async function executeSessionSectionActionV1(actionId: SessionSectionActionIdV1, input: unknown, port: SessionSectionActionPortV1): Promise<unknown> {
  await port.assertCurrent();
  if (actionId === 'session.sections.delete') {
    const { sectionId } = SessionSectionRefV1Schema.parse(input);
    const result = await port.deleteFolder({ folderId: sectionId, assignmentBehavior: 'moveAssignmentsToParent' });
    if ('ok' in result) return result;
    return { sectionId, removed: result.deletedFolderIds.includes(sectionId), affectedAssignmentCount: result.affectedAssignmentCount };
  }
  if (actionId === 'session.section.set') {
    const { sessionId, sectionId } = SessionSectionSetInputV1Schema.parse(input);
    const snapshot = await port.readSnapshot({ includeFolders: false, includeTags: false, includeLabels: false, assignmentSessionIds: [sessionId] });
    if ('ok' in snapshot) return snapshot;
    // This is the admitted snapshot's captured inverse, not a transactional rollback.
    // Disclose it only after the same Session/destination acknowledges the commit.
    const previousSectionId = snapshot.folderAssignments.find(row => row.sessionId === sessionId)?.folderId ?? null;
    await port.assertCurrent();
    const result = await port.setAssignment(sessionId, sectionId);
    if ('ok' in result) return result;
    if (result.sessionId !== sessionId || result.folderId !== sectionId) return fail('outcome_unknown');
    return { sessionId: result.sessionId, sectionId: result.folderId, previousSectionId };
  }
  if (actionId === 'session.sections.archive') {
    const { sectionId } = SessionSectionRefV1Schema.parse(input);
    if (!port.archiveSession) return fail('unsupported_action');
    const snapshot = await port.readSnapshot({ ...definitionsRequest, folderIds: [sectionId], includeAllFolderAssignments: false });
    if ('ok' in snapshot) return snapshot;
    if (!snapshot.folders.some(row => row.folderId === sectionId && row.archivedAt === null)) return fail('section_not_found');
    const archivedSessionIds: string[] = [], unknownSessionIds: string[] = [], failures: { sessionId: string; code: string }[] = [];
    for (const sessionId of new Set(snapshot.folderAssignments.filter(row => row.folderId === sectionId).map(row => row.sessionId))) {
      let execution: ActionExecuteResult;
      let invoked = false;
      try {
        await port.assertCurrent();
        invoked = true;
        execution = await port.archiveSession(sessionId);
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code : projectUnexpectedActionFailureV1(invoked ? null : false).errorCode;
        if (isActionOutcomeUnknownErrorCodeV1(code)) unknownSessionIds.push(sessionId);
        else failures.push({ sessionId, code });
        continue;
      }
      const failure = readActionFailureEnvelope(execution);
      if (failure) {
        if (isActionOutcomeUnknownErrorCodeV1(failure.errorCode)) unknownSessionIds.push(sessionId);
        else failures.push({ sessionId, code: failure.errorCode });
        continue;
      }
      const result = execution.ok ? SessionArchiveActionResultV1Schema.safeParse(execution.result) : null;
      if (result?.success && result.data.sessionId === sessionId) archivedSessionIds.push(sessionId);
      else if (execution.ok && typeof execution.result === 'object' && execution.result !== null
        && 'kind' in execution.result && execution.result.kind === 'approval_request_created') failures.push({ sessionId, code: 'approval_pending' });
      else unknownSessionIds.push(sessionId);
    }
    return { archivedSessionIds, failures, unknownSessionIds };
  }
  const requestedId = actionId === 'session.sections.update' ? SessionSectionsUpdateInputV1Schema.parse(input).sectionId : null;
  const createFolderId = actionId === 'session.sections.create' ? port.allocateFolderId() : null;
  const snapshot = await port.readSnapshot({ ...definitionsRequest, ...(requestedId ? { folderIds: [requestedId] } : {}) });
  if ('ok' in snapshot) return snapshot;
  const folders = snapshot.folders.filter(row => row.archivedAt === null).slice().sort(compareFolders);
  if (actionId === 'session.sections.list') {
    await port.assertCurrent();
    return { sections: folders.map(projectSessionSectionV1) };
  }
  if (actionId === 'session.sections.update') {
    const request = SessionSectionsUpdateInputV1Schema.parse(input);
    const folder = folders.find(row => row.folderId === request.sectionId);
    if (!folder) return fail('section_not_found');
    const section = projectSessionSectionV1(folder);
    if (section.displayState.status === 'locked') return fail(section.displayState.reason);
    const display = { name: request.name ?? section.displayState.value.name,
      icon: request.icon === undefined ? section.displayState.value.icon : request.icon };
    await port.assertCurrent();
    const result = await port.upsertFolder({ ...folderRequest(folder), display: { t: 'plain', v: display } });
    return 'ok' in result ? result : { section: projectSessionSectionV1(result) };
  }
  // Retained null/padded/duplicate keys are repaired only on an explicit order mutation.
  const ensureOrderKeys = async (): Promise<ActionExecuteFailure | null> => {
    try {
      let previous: string | null = null;
      for (const folder of folders) {
        if (folder.sortKey === null || previous === folder.sortKey) throw new Error('unarranged');
        generateKeyBetween(folder.sortKey, null);
        previous = folder.sortKey;
      }
      return null;
    } catch {
      // An opened legacy display may have no name (including display:null).
      // Order writes preserve that envelope; only genuinely unreadable bytes
      // must block repair, not the Section label projection's unavailable state.
      const locked = folders.find(folder => folder.displayState.status === 'locked');
      if (locked?.displayState.status === 'locked') return fail(locked.displayState.reason);
      const keys = generateNKeysBetween(null, null, folders.length);
      for (let index = 0; index < folders.length; index++) {
        const folder = folders[index]!;
        const result = await port.upsertFolder(folderRequest(folder, keys[index]!));
        if ('ok' in result) return result;
        folders[index] = result;
      }
      return null;
    }
  };
  if (actionId === 'session.sections.create') {
    const request = SessionSectionsCreateInputV1Schema.parse(input);
    const existing = folders.find(folder => folder.folderId === createFolderId);
    if (existing) return { section: projectSessionSectionV1(existing) };
    const { sortKey } = resolveSessionSectionCreatePlacementV1(folders.map(folder => ({ sectionId: folder.folderId, sortKey: folder.sortKey })));
    const folderId = createFolderId!;
    await port.assertCurrent();
    const result = await port.upsertFolder({ folderId, folderKey: folderId, parentFolderId: null, parentFolderKey: null,
      sortKey, display: { t: 'plain', v: { name: request.name, icon: request.icon ?? null } } });
    return 'ok' in result ? result : { section: projectSessionSectionV1(result) };
  }
  const request = SessionSectionsReorderInputV1Schema.parse(input);
  const folder = folders.find(row => row.folderId === request.sectionId);
  if (!folder || request.beforeSectionId !== null && !folders.some(row => row.folderId === request.beforeSectionId)) return fail('section_not_found');
  const section = projectSessionSectionV1(folder);
  if (section.displayState.status === 'locked') return fail(section.displayState.reason);
  if (request.beforeSectionId === request.sectionId) return { sectionId: folder.folderId, sortKey: folder.sortKey };
  const failure = await ensureOrderKeys();
  if (failure) return failure;
  const siblings = folders.filter(row => row.folderId !== request.sectionId);
  const beforeIndex = request.beforeSectionId === null ? siblings.length : siblings.findIndex(row => row.folderId === request.beforeSectionId);
  const sortKey = generateKeyBetween(siblings[beforeIndex - 1]?.sortKey ?? null, siblings[beforeIndex]?.sortKey ?? null);
  await port.assertCurrent();
  const result = await port.upsertFolder(folderRequest(folders.find(row => row.folderId === request.sectionId)!, sortKey));
  return 'ok' in result ? result : { sectionId: result.folderId, sortKey: result.sortKey };
}
