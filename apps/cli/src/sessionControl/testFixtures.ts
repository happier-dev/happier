import type { V2SessionListResponse, V2SessionRecord } from '@happier-dev/protocol';

export type SessionFixtureRow = V2SessionRecord;
export type SessionFixtureListResponse = V2SessionListResponse;

export function makeSessionFixtureRow(
  overrides: Partial<SessionFixtureRow> & Pick<SessionFixtureRow, 'id'>,
): SessionFixtureRow {
  const { id, ...rest } = overrides;
  return {
    id,
    seq: 0,
    createdAt: 0,
    updatedAt: 0,
    active: false,
    activeAt: 0,
    archivedAt: null,
    metadata: 'metadata',
    metadataVersion: 1,
    agentState: null,
    agentStateVersion: 0,
    pendingCount: 0,
    pendingVersion: 0,
    dataEncryptionKey: null,
    ...rest,
  };
}

export function makeSessionFixtureListResponse(
  rows: Array<SessionFixtureRow>,
  options: {
    nextCursor?: string | null;
    hasNext?: boolean;
  } = {},
): SessionFixtureListResponse {
  return {
    sessions: rows,
    nextCursor: options.nextCursor ?? null,
    hasNext: options.hasNext ?? false,
  };
}
