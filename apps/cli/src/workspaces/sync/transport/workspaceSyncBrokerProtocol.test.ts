import { describe, expect, it } from 'vitest';
import {
  BrokerControlFrameDecoder,
  BrokerProtocolError,
  createBrokerHelloProof,
  deriveWorkspaceSyncEndpointId,
  encodeBrokerCommandFrame,
  encodeBrokerControlFrame,
  isBrokerTerminalErrorCode,
  parseBrokerControlV1,
  parseMutagenControlCommandV1,
  WORKSPACE_SYNC_BROKER_MAX_REQUEST_FRAME_BYTES,
} from './workspaceSyncBrokerProtocol';
const validPolicy = { selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };

describe('workspace sync broker protocol', () => {
  it('preserves the native uint64 change index without JSON number rounding', () => {
    for (const previousStateIndex of ['0', '9007199254740993', '18446744073709551615']) {
      const command = { t: 'wait_for_change', requestId: 'wait-1', previousStateIndex };
      expect(parseMutagenControlCommandV1(command)).toEqual(command);
    }
    for (const previousStateIndex of [1, '-1', '01', '18446744073709551616']) {
      expect(() => parseMutagenControlCommandV1({ t: 'wait_for_change', requestId: 'wait-1', previousStateIndex })).toThrow();
    }
  });
  it('frames control JSON with a big-endian length and decodes fragmented input', () => {
    const frame = encodeBrokerControlFrame({ t: 'open_data', requestId: 'r1', endpointId: 'ws1_ep', expiresAtMs: 100 });
    expect(frame.readUInt32BE(0)).toBe(frame.byteLength - 4);
    const decoder = new BrokerControlFrameDecoder();
    expect(decoder.push(frame.subarray(0, 2))).toEqual([]);
    expect(decoder.push(frame.subarray(2))).toEqual([{ t: 'open_data', requestId: 'r1', endpointId: 'ws1_ep', expiresAtMs: 100 }]);
  });

  it('rejects unknown fields and oversized frames', () => {
    expect(() => parseBrokerControlV1({ t: 'open_data', requestId: 'r', endpointId: 'e', expiresAtMs: 1, extra: true })).toThrow(/unknown broker control field/);
    const decoder = new BrokerControlFrameDecoder();
    const bad = Buffer.alloc(4); bad.writeUInt32BE(65 * 1024);
    expect(() => decoder.push(bad)).toThrow(/invalid broker frame length/);
    expect(() => parseBrokerControlV1({ t: 'command', requestId: 'outer', command: { t: 'list', requestId: 'inner', nope: true } })).toThrow(/unknown mutagen command field/);
  });

  it('uses a stable length-delimited hello proof', () => {
    const hello = { protocol: 1 as const, brokerInstanceId: 'b', launchNonce: 'n', sidecarPid: 42 };
    expect(createBrokerHelloProof(Buffer.alloc(32, 1), hello)).toBe(createBrokerHelloProof(Buffer.alloc(32, 1), hello));
    expect(createBrokerHelloProof(Buffer.alloc(32, 1), hello)).not.toBe(createBrokerHelloProof(Buffer.alloc(32, 2), hello));
  });

  it('derives opaque endpoint ids deterministically from relationship id and role', () => {
    const alpha = deriveWorkspaceSyncEndpointId('rel-1', 'alpha');
    expect(alpha).toMatch(/^ws1_[a-z2-7]{32}$/u);
    expect(alpha).toBe('ws1_hjjfzd5njl4rdwegflylq5wsramkjhnk');
    expect(deriveWorkspaceSyncEndpointId('rel-1', 'alpha')).toBe(alpha);
    expect(deriveWorkspaceSyncEndpointId('rel-1', 'beta')).not.toBe(alpha);
    expect(deriveWorkspaceSyncEndpointId('rel-2', 'alpha')).not.toBe(alpha);
    expect(() => deriveWorkspaceSyncEndpointId('', 'alpha')).toThrow();
    expect(() => deriveWorkspaceSyncEndpointId('rel-1', 'gamma' as 'alpha')).toThrow();
  });

  it('exposes typed terminal error codes and a typed protocol error', () => {
    expect(isBrokerTerminalErrorCode('relationship_not_owned')).toBe(true);
    expect(isBrokerTerminalErrorCode('cursor_invalidated')).toBe(true);
    expect(isBrokerTerminalErrorCode('something_else')).toBe(false);
    const error = new BrokerProtocolError('root_mismatch', 'root changed');
    expect(error.code).toBe('root_mismatch');
    expect(isBrokerTerminalErrorCode((error as { code?: unknown }).code)).toBe(true);
  });

  it('validates the fork-owned generic manager command union', () => {
    const session = {
      alpha: 'external://opaque-alpha',
      beta: 'external://opaque-beta',
      mode: 'one-way-safe' as const,
      contentPolicy: validPolicy,
      name: 'rel-1',
      labels: { 'external.owner': 'happier-workspace-sync' },
    };
    expect(() => parseBrokerControlV1({ t: 'command', requestId: 'r1', command: { t: 'create', requestId: 'r1', session } })).not.toThrow();
    expect(() => parseBrokerControlV1({ t: 'command', requestId: 'r1', command: { t: 'create', requestId: 'r1', session: { ...session, contentPolicy: { ...validPolicy, includeGitDirectory: false } } } })).toThrow(/contentPolicy/);
    expect(() => parseBrokerControlV1({ t: 'command', requestId: 'r1', command: { t: 'create', requestId: 'r1', session: { ...session, alpha: '/tmp/source' } } })).toThrow(/external/);
    expect(() => parseBrokerControlV1({ t: 'command', requestId: 'r1', command: { t: 'resume', requestId: 'r1', sessionIdentifier: 'mutagen-session-1' } })).not.toThrow();
    expect(() => parseBrokerControlV1({ t: 'command', requestId: 'r1', command: { t: 'resume', requestId: 'r1', relationshipId: 'rel-1' } })).toThrow();
    expect(() => parseBrokerControlV1({ t: 'command', requestId: 'r1', command: { t: 'copy_once', requestId: 'r1' } })).toThrow(/unknown mutagen control command/);
    expect(() => parseBrokerControlV1({ t: 'command', requestId: 'r1', command: { t: 'delete_conflict_loser', requestId: 'r1' } })).toThrow(/unknown mutagen control command/);
    expect(() => parseBrokerControlV1({ t: 'command', requestId: 'r1', command: { t: 'bogus', requestId: 'r1' } })).toThrow(/unknown mutagen control command/);
  });

  it('admits only an endpoint-relative selection diagnosis for a selected side', () => {
    const command = { t: 'diagnose_selection', requestId: 'r1', sessionIdentifier: 'session-1', side: 'beta', path: 'src/file.ts' };
    expect(parseMutagenControlCommandV1(command)).toEqual(command);
    expect(() => parseMutagenControlCommandV1({ ...command, side: 'other' })).toThrow();
    expect(() => parseMutagenControlCommandV1({ ...command, path: '../escape' })).toThrow();
    expect(() => parseMutagenControlCommandV1({ ...command, path: 'src\\file.ts' })).toThrow();
    expect(() => parseMutagenControlCommandV1({ ...command, root: '/other' })).toThrow();
  });

  it('requires bounded cursor pagination for exhaustive manager LIST', () => {
    expect(() => parseBrokerControlV1({
      t: 'command', requestId: 'r1',
      command: { t: 'list', requestId: 'r1', limit: 100 },
    })).not.toThrow();
    expect(() => parseBrokerControlV1({
      t: 'command', requestId: 'r1',
      command: { t: 'list', requestId: 'r1', cursor: 'mutagen-session-100', limit: 100 },
    })).not.toThrow();
    expect(() => parseBrokerControlV1({
      t: 'command', requestId: 'r1', command: { t: 'list', requestId: 'r1' },
    })).toThrow(/limit/);
    expect(() => parseBrokerControlV1({
      t: 'command', requestId: 'r1', command: { t: 'list', requestId: 'r1', cursor: '', limit: 100 },
    })).toThrow(/cursor/);
    expect(() => parseBrokerControlV1({
      t: 'command', requestId: 'r1', command: { t: 'list', requestId: 'r1', limit: 101 },
    })).toThrow(/limit/);
  });

  it('admits a valid maximum-size content policy within the derived request-only frame limit', () => {
    const pattern = 'x'.repeat(1024);
    const command = {
      t: 'create' as const,
      requestId: 'r-max-policy',
      session: {
        alpha: 'external://opaque-alpha', beta: 'external://opaque-beta', mode: 'one-way-safe' as const,
        contentPolicy: {
          selection: 'all_files' as const,
          extraIgnorePatterns: Array.from({ length: 128 }, (_, index) => `${index}-${pattern}`.slice(0, 1024)),
          extraIncludePatterns: Array.from({ length: 128 }, (_, index) => `${index}-${pattern}`.slice(0, 1024)),
        },
        name: 'rel-max-policy', labels: { 'external.owner': 'happier-workspace-sync' },
      },
    };

    expect(() => encodeBrokerControlFrame({ t: 'command', requestId: command.requestId, command })).toThrow(/too large/);
    const frame = encodeBrokerCommandFrame(command);
    expect(frame.readUInt32BE(0)).toBeGreaterThan(65_536);
    expect(frame.readUInt32BE(0)).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(() => new BrokerControlFrameDecoder().push(frame)).toThrow(/invalid broker frame length/);
    const requestDecoder = new BrokerControlFrameDecoder({ maxFrameBytes: WORKSPACE_SYNC_BROKER_MAX_REQUEST_FRAME_BYTES });
    expect(requestDecoder.push(frame)).toHaveLength(1);
    const oversizedResponsePayload = Buffer.from(JSON.stringify({ t: 'result', requestId: 'r1', result: 'x'.repeat(70_000) }), 'utf8');
    const oversizedResponse = Buffer.allocUnsafe(4 + oversizedResponsePayload.byteLength);
    oversizedResponse.writeUInt32BE(oversizedResponsePayload.byteLength, 0);
    oversizedResponsePayload.copy(oversizedResponse, 4);
    expect(() => requestDecoder.push(oversizedResponse)).toThrow(/not a manager command/);
  });

  it('bounds incomplete frames after the declared length and preserves fragmented request frames', () => {
    const frame = encodeBrokerCommandFrame({
      t: 'list', requestId: 'fragmented', limit: 100,
    });
    const decoder = new BrokerControlFrameDecoder({ maxFrameBytes: WORKSPACE_SYNC_BROKER_MAX_REQUEST_FRAME_BYTES });
    expect(decoder.push(frame.subarray(0, 1))).toEqual([]);
    expect(decoder.push(frame.subarray(1, 4))).toEqual([]);
    expect(decoder.bufferedBytes).toBe(4);
    expect(decoder.push(frame.subarray(4))).toHaveLength(1);

    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(WORKSPACE_SYNC_BROKER_MAX_REQUEST_FRAME_BYTES + 1, 0);
    expect(() => decoder.push(oversized)).toThrow(/invalid broker frame length/);
  });

  it('requires cursors on paged conflict and policy reads to be bounded identifiers', () => {
    for (const t of ['list_conflicts', 'get_policy'] as const) {
      expect(() => parseBrokerControlV1({
        t: 'command', requestId: 'r1', command: {
          t, requestId: 'r1', sessionIdentifier: 'session-1', limit: 100,
        },
      })).not.toThrow();
      expect(() => parseBrokerControlV1({
        t: 'command', requestId: 'r1', command: {
          t, requestId: 'r1', sessionIdentifier: 'session-1', cursor: 'next-page', limit: 100,
        },
      })).not.toThrow();
      expect(() => parseBrokerControlV1({
        t: 'command', requestId: 'r1', command: {
          t, requestId: 'r1', sessionIdentifier: 'session-1', cursor: '', limit: 100,
        },
      })).toThrow(/cursor/);
    }
  });

  it('rejects negated positive include patterns at the broker command boundary', () => {
    expect(() => encodeBrokerCommandFrame({
      t: 'create', requestId: 'r1', session: {
        alpha: 'external://alpha', beta: 'external://beta', mode: 'one-way-safe', name: 'session', labels: {},
        contentPolicy: { selection: 'all_files', extraIgnorePatterns: [], extraIncludePatterns: ['!src/generated.ts'] },
      },
    })).toThrow(/extraIncludePatterns/);
  });
});
