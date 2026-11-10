import { describe, expect, it } from 'vitest';
import type {
  InteractionTransientApprovalAuthorRequestV1,
  InteractionTransientApprovalResultV1,
} from '@happier-dev/plugin-sdk/interactions';

import {
  buildOpenCodePermissionApprovalRequest,
  mapOpenCodeApprovalResultToReply,
  readOpenCodeApprovalReplyMessage,
  readOpenCodePermissionAsk,
  readOpenCodePermissionRequestId,
} from './permissionBridge.js';
import { normalizeOpenCodeV2PermissionRequest } from './openCodeV2Wire.js';
import { buildOpenCodeSessionMcpProjection } from './mcpRegistration.js';

const ASK = {
  requestId: 'permission-1',
  providerSessionId: 'provider-session-1',
  permission: 'bash',
  patterns: ['git status'],
  metadata: { command: 'git status' },
} as const;

describe('OpenCode native tool approval bridge', () => {
  it('translates native MCP aliases to the exact open-request server key', () => {
    const projection = buildOpenCodeSessionMcpProjection('session-a', {
      'docs.team__prod': { command: '/fixture/mcp' },
    });
    const alias = projection.registrations[0]!.projectedName;
    expect(buildOpenCodePermissionApprovalRequest({ ...ASK, permission: `${alias}_search` }, projection).subject)
      .toMatchObject({ kind: 'tool', name: 'mcp__docs.team__prod__search' });
  });
  it('does not turn a host MCP session grant into a vendor grant that bypasses future policy edits', () => {
    expect(mapOpenCodeApprovalResultToReply({ requestId: 'approval', kind: 'approval', status: 'approved', persistence: 'session' }, true)).toBe('once');
  });
  it('recovers named MCP tools from native sanitized spellings and refuses ambiguous aliases', () => {
    const projection = buildOpenCodeSessionMcpProjection('session-a', { docs: { command: '/fixture/mcp' } });
    const ask = { ...ASK, permission: `${projection.registrations[0]!.projectedName}_file_read` };
    expect(buildOpenCodePermissionApprovalRequest(ask, projection, { docs: { unlisted: 'ask', tools: { 'file.read': 'off' } } }).subject)
      .toMatchObject({ name: 'mcp__docs__file.read' });
    expect(buildOpenCodePermissionApprovalRequest(ask, projection, { docs: { unlisted: 'ask', tools: { 'file.read': 'off', 'file/read': 'allow' } } }).subject)
      .toMatchObject({ name: ask.permission });
  });
  it('offers the supported native replies with occurrence-owned canonical payloads', () => {
    expect(buildOpenCodePermissionApprovalRequest(ASK)).toEqual({
      kind: 'approval',
      title: 'Allow OpenCode to use bash?',
      description: 'OpenCode requested permission to use bash.',
      subject: {
        kind: 'tool',
        name: 'bash',
        input: {
          providerSessionId: 'provider-session-1',
          permission: 'bash',
          patterns: ['git status'],
          metadata: { command: 'git status' },
        },
      },
      allowSessionPersistence: true,
      nativeChoices: {
        requirementId: ASK.requestId,
        source: 'opencode',
        choices: [
          { id: 'allow', label: 'Allow once', decision: 'approved', scope: 'once', response: { approved: true, decision: 'approved' } },
          { id: 'allow_session', label: 'Allow for this session', decision: 'approved_for_session', scope: 'session',
            response: { approved: true, decision: 'approved_for_session', allowedTools: ['bash'] } },
          { id: 'deny', label: 'Deny', decision: 'denied', scope: 'once', response: { approved: false, decision: 'denied' } },
          { id: 'stop', label: 'Stop', decision: 'abort', scope: 'once', response: { approved: false, decision: 'abort' } },
        ],
      },
    } satisfies InteractionTransientApprovalAuthorRequestV1);
  });

  it.each([
    [{ requestId: 'approval-1', kind: 'approval', status: 'approved', persistence: 'once' }, 'once'],
    [{ requestId: 'approval-2', kind: 'approval', status: 'approved', persistence: 'session' }, 'always'],
    [{ requestId: 'approval-3', kind: 'approval', status: 'declined' }, 'reject'],
    [{ requestId: 'approval-4', kind: 'approval', status: 'userCancelled' }, 'reject'],
    [{ requestId: 'approval-5', kind: 'approval', status: 'unavailable' }, 'reject'],
  ] satisfies readonly (readonly [InteractionTransientApprovalResultV1, 'once' | 'always' | 'reject'])[])(
    'maps %o to the fail-closed OpenCode reply %s',
    (result, expected) => {
      expect(mapOpenCodeApprovalResultToReply(result)).toBe(expected);
    },
  );

  it('does not invent provider-facing messages absent from the strict result contract', () => {
    expect(readOpenCodeApprovalReplyMessage({
      requestId: 'approval-1',
      kind: 'approval',
      status: 'unavailable',
    })).toBeNull();
  });
});
/**
 * Bytes OpenCode minted. The request id is replied to at the provider and the
 * session id routes that reply, so the bridge decides presence only.
 */
const PROVIDER_MINTED_SESSION_ID = '  provider\nses/AB+cd==  ';
const PROVIDER_MINTED_REQUEST_ID = '  provider\nreq/AB+cd==  ';

describe('OpenCode permission request identity', () => {
  it('reads the permission request id as the exact bytes OpenCode minted', () => {
    expect(readOpenCodePermissionRequestId({ id: PROVIDER_MINTED_REQUEST_ID }))
      .toBe(PROVIDER_MINTED_REQUEST_ID);
    expect(readOpenCodePermissionRequestId({ id: '  \n ' })).toBeNull();
  });

  it('keeps the ask addressed to the exact request and session bytes', () => {
    expect(readOpenCodePermissionAsk({
      id: PROVIDER_MINTED_REQUEST_ID,
      sessionID: PROVIDER_MINTED_SESSION_ID,
      permission: 'bash',
    }, PROVIDER_MINTED_SESSION_ID)).toEqual({
      requestId: PROVIDER_MINTED_REQUEST_ID,
      providerSessionId: PROVIDER_MINTED_SESSION_ID,
      permission: 'bash',
      patterns: [],
    });
  });

  it('refuses an ask whose session id disagrees with the owning session by whitespace', () => {
    expect(readOpenCodePermissionAsk({
      id: PROVIDER_MINTED_REQUEST_ID,
      sessionID: PROVIDER_MINTED_SESSION_ID,
      permission: 'bash',
    }, PROVIDER_MINTED_SESSION_ID.trim())).toBeNull();
  });

  it('validates the whole byte-exact V2 resource list at the canonical permission bridge', () => {
    const valid = normalizeOpenCodeV2PermissionRequest({
      id: PROVIDER_MINTED_REQUEST_ID,
      sessionID: PROVIDER_MINTED_SESSION_ID,
      action: '  bash\n',
      resources: ['  src/file.ts\n', '\tcommand --flag  '],
    });
    expect(valid).toEqual({
      id: PROVIDER_MINTED_REQUEST_ID,
      sessionID: PROVIDER_MINTED_SESSION_ID,
      permission: '  bash\n',
      patterns: ['  src/file.ts\n', '\tcommand --flag  '],
    });
    expect(readOpenCodePermissionAsk(valid ?? {}, PROVIDER_MINTED_SESSION_ID)).toEqual({
      requestId: PROVIDER_MINTED_REQUEST_ID,
      providerSessionId: PROVIDER_MINTED_SESSION_ID,
      permission: '  bash\n',
      patterns: ['  src/file.ts\n', '\tcommand --flag  '],
    });

    const mixedInvalid = normalizeOpenCodeV2PermissionRequest({
      id: PROVIDER_MINTED_REQUEST_ID,
      sessionID: PROVIDER_MINTED_SESSION_ID,
      action: 'bash',
      resources: ['src/file.ts', 42, 'README.md'],
    });
    expect(mixedInvalid).toEqual({
      id: PROVIDER_MINTED_REQUEST_ID,
      sessionID: PROVIDER_MINTED_SESSION_ID,
      permission: 'bash',
      patterns: ['src/file.ts', 42, 'README.md'],
    });
    expect(readOpenCodePermissionAsk(mixedInvalid ?? {}, PROVIDER_MINTED_SESSION_ID)).toBeNull();
  });
});
