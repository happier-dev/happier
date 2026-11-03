import axios from 'axios';
import { vi } from 'vitest';
import { ProjectAccountRowMutationRequestV1Schema, ProjectAccountRowV1Schema, ProjectAccountRowReadRequestV1Schema,
  ProjectAccountRowListRequestV1Schema, ProjectAccountRowKeyV1Schema,
  type ProjectAccountRowKeyV1, type ProjectAccountRowMutationRequestV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

export function createPlainProjectAccountRefRow(ref: WorkspaceRefV1, revision = 0) {
  const key = { kind: 'workspace-ref' as const, serverId: ref.serverId, id: ref.id };
  return ProjectAccountRowV1Schema.parse({ key, revision, content: { t: 'plain', v: { key, value: ref } } });
}

/** Wire replies shared by composed fixtures that also serve other Home routes. */
export function projectAccountRowsReadHttpResponse(rows: readonly unknown[], url: string, body: unknown) {
  if (url.endsWith('/list')) {
    const filter = ProjectAccountRowListRequestV1Schema.parse(body);
    const selected = rows.filter(row => {
      const parsed = ProjectAccountRowKeyV1Schema.safeParse(row && typeof row === 'object' ? Reflect.get(row, 'key') : null);
      if (!parsed.success) return true;
      return (!filter.kinds || filter.kinds.includes(parsed.data.kind))
        && (!filter.serverId || parsed.data.kind === 'relationship-graph' || parsed.data.serverId === filter.serverId);
    });
    return { status: 200, data: { status: 'listed', coverage: 'complete', rows: selected } };
  }
  if (!url.endsWith('/read')) throw new Error(`Unexpected Project row read route: ${url}`);
  const { key } = ProjectAccountRowReadRequestV1Schema.parse(body);
  const row = rows.find(row => row !== null && typeof row === 'object'
    && JSON.stringify(Reflect.get(row, 'key')) === JSON.stringify(key));
  if (!row || typeof row !== 'object') return { status: 200, data: { status: 'absent' } };
  return { status: 200, data: Reflect.get(row, 'content') === null
    ? { status: 'deleted', revision: Reflect.get(row, 'revision') } : { status: 'present', row } };
}

/** Account HTTP is the system boundary; real CLI row/graph admission runs beneath this adapter. */
export function createProjectAccountRowsHttpBoundary(rows: unknown[], options: Readonly<{
  beforeMutation?: (request: ProjectAccountRowMutationRequestV1) => void;
}> = {}) {
  const indexFor = (key: ProjectAccountRowKeyV1) => rows.findIndex(row => row !== null && typeof row === 'object'
    && JSON.stringify(Reflect.get(row, 'key')) === JSON.stringify(key));
  return async (url: string, body: unknown) => {
    if (url.endsWith('/list') || url.endsWith('/read')) return projectAccountRowsReadHttpResponse(rows, url, body);
    const request = ProjectAccountRowMutationRequestV1Schema.parse(body);
    options.beforeMutation?.(request);
    // The transport's revision assertions settle atomically, including retained tombstones.
    for (const assertion of [...request.mutations, ...request.expectedRefs]) {
      const index = indexFor(assertion.key);
      const revision = index < 0 ? -1 : ProjectAccountRowV1Schema.parse(rows[index]).revision;
      if (revision !== (assertion.expectedRevision === 'absent' ? -1 : assertion.expectedRevision)) {
        return { status: 200, data: { status: 'conflict', key: assertion.key, revision } };
      }
    }
    const acknowledged = request.mutations.map(mutation => ({ key: mutation.key,
      revision: mutation.expectedRevision === 'absent' ? 0 : mutation.expectedRevision + 1, content: mutation.content }));
    for (const row of acknowledged) {
      const index = indexFor(row.key);
      if (index < 0) rows.push(row); else rows[index] = row;
    }
    return { status: 200, data: { status: 'updated', rows: acknowledged, cursor: 1 } };
  };
}

export function mockProjectAccountRowsHttpBoundary(rows: unknown[], options: Readonly<{
  beforeMutation?: (request: ProjectAccountRowMutationRequestV1) => void;
}> = {}) {
  vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 0 } });
  return vi.spyOn(axios, 'post').mockImplementation(createProjectAccountRowsHttpBoundary(rows, options));
}
