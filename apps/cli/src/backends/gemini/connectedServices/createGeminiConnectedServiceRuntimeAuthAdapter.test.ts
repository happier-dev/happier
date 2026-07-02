import { describe, expect, it } from 'vitest';

import {
  ConnectedServiceQuotaSnapshotV1Schema,
  buildConnectedServiceCredentialRecord,
} from '@happier-dev/protocol';

import { createGeminiConnectedServiceRuntimeAuthAdapter } from './createGeminiConnectedServiceRuntimeAuthAdapter';

function buildGeminiOauthRecord() {
  return buildConnectedServiceCredentialRecord({
    now: 1_700_000_000_000,
    serviceId: 'gemini',
    profileId: 'gemini-work',
    kind: 'oauth',
    expiresAt: 1_700_000_060_000,
    oauth: {
      accessToken: 'gemini-access-token',
      refreshToken: 'gemini-refresh-token',
      idToken: 'gemini-id-token',
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      tokenType: 'Bearer',
      providerAccountId: 'google-account',
      providerEmail: 'user@example.com',
    },
  });
}

describe('createGeminiConnectedServiceRuntimeAuthAdapter', () => {
  it('classifies structured Gemini quota failures into runtime-auth recovery facts', () => {
    const adapter = createGeminiConnectedServiceRuntimeAuthAdapter();

    expect(adapter.classifyRuntimeAuthFailure({
      target: { agentId: 'gemini' },
      error: {
        code: 'usage_limit_reached',
        message: 'Gemini Code Assist quota limit reached',
        reset_at: '2026-05-18T12:00:00.000Z',
      },
      selection: {
        serviceId: 'gemini',
        groupId: 'group-gemini',
        activeProfileId: 'gemini-work',
      },
    })).toMatchObject({
      kind: 'usage_limit',
      limitCategory: 'usage_limit',
      serviceId: 'gemini',
      profileId: 'gemini-work',
      groupId: 'group-gemini',
      resetsAtMs: Date.parse('2026-05-18T12:00:00.000Z'),
      quotaScope: 'account',
      source: 'structured_provider_error',
      rateLimits: expect.objectContaining({
        limitCategory: 'usage_limit',
        resetAtMs: Date.parse('2026-05-18T12:00:00.000Z'),
      }),
    });
  });

  it('probes Gemini Code Assist quota with the selected connected-service OAuth record', async () => {
    const requests: Array<Readonly<{ url: string; init: RequestInit }>> = [];
    const fetchRuntime = async (url: string, init: RequestInit): Promise<Response> => {
      requests.push({ url, init });
      if (url.endsWith(':loadCodeAssist')) {
        return Response.json({
          currentTier: { id: 'free-tier', name: 'Gemini Code Assist' },
          cloudaicompanionProject: 'happier-gemini-project',
        });
      }
      return Response.json({
        buckets: [
          {
            modelId: 'gemini-2.5-pro',
            remainingFraction: 0.25,
            remainingAmount: '50',
            resetTime: '2026-05-18T12:00:00.000Z',
          },
          {
            modelId: 'gemini-2.5-flash',
            remainingFraction: 0,
            resetTime: '2026-05-18T13:00:00.000Z',
          },
        ],
      });
    };
    const recordedSnapshots: unknown[] = [];
    const adapter = createGeminiConnectedServiceRuntimeAuthAdapter({
      fetchRuntime,
      now: () => 1_800_000_000_000,
    });

    const result = await adapter.probeQuota({
      target: { agentId: 'gemini' },
      selection: {
        groupId: 'group-gemini',
        record: buildGeminiOauthRecord(),
        runtimeQuotaSnapshots: {
          recordSnapshot(input: unknown) {
            recordedSnapshots.push(input);
          },
        },
      },
    });

    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.url)).toEqual([
      'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
      'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
    ]);
    expect(requests[0]?.init).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        authorization: 'Bearer gemini-access-token',
      }),
    });
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual({
      project: 'happier-gemini-project',
    });
    expect(result).toMatchObject({ status: 'available' });
    const snapshot = ConnectedServiceQuotaSnapshotV1Schema.parse(result.quotaSnapshot);
    expect(snapshot).toMatchObject({
      serviceId: 'gemini',
      profileId: 'gemini-work',
      fetchedAt: 1_800_000_000_000,
      meters: [
        {
          meterId: 'gemini-2.5-pro',
          label: 'gemini-2.5-pro',
          used: 150,
          limit: 200,
          utilizationPct: 75,
          resetsAt: Date.parse('2026-05-18T12:00:00.000Z'),
        },
        {
          meterId: 'gemini-2.5-flash',
          label: 'gemini-2.5-flash',
          used: 100,
          limit: 100,
          utilizationPct: 100,
          resetsAt: Date.parse('2026-05-18T13:00:00.000Z'),
        },
      ],
    });
    expect(recordedSnapshots).toEqual([
      {
        serviceId: 'gemini',
        groupId: 'group-gemini',
        profileId: 'gemini-work',
        snapshot,
      },
    ]);
  });

  it('does not retrieve quota when Code Assist has no resolved project', async () => {
    const requestedUrls: string[] = [];
    const adapter = createGeminiConnectedServiceRuntimeAuthAdapter({
      fetchRuntime: async (url) => {
        requestedUrls.push(url);
        return Response.json({ currentTier: null, cloudaicompanionProject: null });
      },
    });

    await expect(adapter.probeQuota({
      target: { agentId: 'gemini' },
      selection: { record: buildGeminiOauthRecord() },
    })).resolves.toEqual({
      status: 'unsupported',
      reason: 'gemini_code_assist_project_unavailable',
    });
    expect(requestedUrls).toEqual([
      'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
    ]);
  });

  it('reports unsupported when the upstream quota request fails', async () => {
    const adapter = createGeminiConnectedServiceRuntimeAuthAdapter({
      fetchRuntime: async (url) => {
        if (url.endsWith(':loadCodeAssist')) {
          return Response.json({ cloudaicompanionProject: 'happier-gemini-project' });
        }
        return Response.json({ error: { message: 'quota unavailable' } }, { status: 503 });
      },
    });

    await expect(adapter.probeQuota({
      target: { agentId: 'gemini' },
      selection: { record: buildGeminiOauthRecord() },
    })).resolves.toEqual({
      status: 'unsupported',
      reason: 'gemini_code_assist_request_failed',
    });
  });

  it('does not classify generic quota text as Gemini provider evidence', () => {
    const adapter = createGeminiConnectedServiceRuntimeAuthAdapter();

    expect(adapter.classifyRuntimeAuthFailure({
      target: { agentId: 'gemini' },
      error: new Error('quota exceeded'),
      selection: {
        groupId: 'group-gemini',
        profileId: 'gemini-work',
      },
    })).toBeNull();
  });
});
