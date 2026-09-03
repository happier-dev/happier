import { afterEach, describe, expect, it, vi } from 'vitest';

import { patchPlainAccountSettingsV2 } from './accountSettings';

describe('patchPlainAccountSettingsV2', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('merges a patch over the authoritative server settings in one CAS update', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        content: {
          t: 'plain',
          v: {
            sessionListActiveGroupingV1: 'date',
            sessionListInactiveGroupingV1: 'date',
            unrelatedSetting: true,
          },
        },
        version: 7,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, version: 8 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await patchPlainAccountSettingsV2({
      baseUrl: 'http://server.test',
      token: 'token',
      settingsPatch: {
        sessionListActiveGroupingV1: 'project',
        sessionListInactiveGroupingV1: 'project',
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, updateInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(updateInit.body))).toEqual({
      expectedVersion: 7,
      content: {
        t: 'plain',
        v: {
          sessionListActiveGroupingV1: 'project',
          sessionListInactiveGroupingV1: 'project',
          unrelatedSetting: true,
        },
      },
    });
  });
});
