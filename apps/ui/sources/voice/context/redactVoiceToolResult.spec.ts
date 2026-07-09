import { describe, expect, it } from 'vitest';

import { redactVoiceToolResultValue } from './redactVoiceToolResult';

const SHARE_ALL = { shareFilePaths: true, shareSessionSummary: true, sharePermissionRequests: true } as const;

describe('redactVoiceToolResultValue', () => {
  it('drops session titles (summaries) when shareSessionSummary is false', () => {
    const result = redactVoiceToolResultValue(
      { ok: true, session: { id: 's1', title: 'Secret Summary', serverName: 'Box' } },
      { ...SHARE_ALL, shareSessionSummary: false },
    ) as { session: Record<string, unknown> };

    expect(result.session.title).toBeUndefined();
    expect(result.session.id).toBe('s1');
    expect(result.session.serverName).toBe('Box');
  });

  it('drops session titles nested inside session arrays', () => {
    const result = redactVoiceToolResultValue(
      { ok: true, sessions: [{ id: 's1', title: 'Secret A' }, { id: 's2', title: 'Secret B' }] },
      { ...SHARE_ALL, shareSessionSummary: false },
    ) as { sessions: Array<Record<string, unknown>> };

    expect(result.sessions[0]!.title).toBeUndefined();
    expect(result.sessions[1]!.title).toBeUndefined();
    expect(result.sessions.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('keeps session titles when shareSessionSummary is true', () => {
    const result = redactVoiceToolResultValue(
      { ok: true, session: { id: 's1', title: 'Visible Summary' } },
      SHARE_ALL,
    ) as { session: Record<string, unknown> };

    expect(result.session.title).toBe('Visible Summary');
  });

  it('drops session summary keys under label/name aliases when shareSessionSummary is false (X-L2)', () => {
    const result = redactVoiceToolResultValue(
      { ok: true, sessions: [{ id: 's1', label: 'Secret Label' }, { id: 's2', name: 'Secret Name' }] },
      { ...SHARE_ALL, shareSessionSummary: false },
    ) as { sessions: Array<Record<string, unknown>> };

    expect(result.sessions[0]!.label).toBeUndefined();
    expect(result.sessions[1]!.name).toBeUndefined();
    expect(result.sessions.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('keeps label/name session keys when shareSessionSummary is true', () => {
    const result = redactVoiceToolResultValue(
      { ok: true, session: { id: 's1', label: 'Visible Label', name: 'Visible Name' } },
      SHARE_ALL,
    ) as { session: Record<string, unknown> };

    expect(result.session.label).toBe('Visible Label');
    expect(result.session.name).toBe('Visible Name');
  });

  it('drops location labels and redacts path-like strings when shareFilePaths is false', () => {
    const result = redactVoiceToolResultValue(
      { ok: true, session: { id: 's1', locationLabel: 'voice-agent' }, path: '/Users/leeroy/secret' },
      { ...SHARE_ALL, shareFilePaths: false },
    ) as { session: Record<string, unknown>; path: string };

    expect(result.session.locationLabel).toBeUndefined();
    expect(result.path).toBe('<path_redacted>');
  });

  it('drops pending permission-request identifiers when sharePermissionRequests is false', () => {
    const result = redactVoiceToolResultValue(
      { ok: true, sessionId: 's1', permissionRequestIds: ['req_1', 'req_2'] },
      { ...SHARE_ALL, sharePermissionRequests: false },
    ) as { permissionRequestIds?: unknown; sessionId: string };

    expect(result.permissionRequestIds).toBeUndefined();
    expect(result.sessionId).toBe('s1');
  });

  it('keeps permission-request identifiers when sharePermissionRequests is true', () => {
    const result = redactVoiceToolResultValue(
      { ok: true, permissionRequestIds: ['req_1'] },
      SHARE_ALL,
    ) as { permissionRequestIds: string[] };

    expect(result.permissionRequestIds).toEqual(['req_1']);
  });
});
