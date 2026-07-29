import { describe, expect, it } from 'vitest';

async function loadRemoteUpdatesModule() {
  return import('./remoteUpdates.js').catch(() => null);
}

function createContentState(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    generatedAt: 1_762_000_000_000,
    staleAt: 1_762_001_800_000,
    sessionId: 'session-1',
    title: 'Review branch',
    subtitle: 'happier/dev',
    previewText: 'Ready for approval',
    statusText: 'Permission required',
    attentionState: 'permission_required',
    defaultTarget: 'happier://activity/inbox',
    sessionTarget: 'happier://session/session-1',
    overflowCount: 0,
    totalAttentionCount: 1,
    allowActionButtons: true,
    labels: {
      title: 'Happier',
      openLabel: 'Open',
      inboxLabel: 'Inbox',
      attentionLabel: 'Attention',
    },
    ...overrides,
  };
}

function createRemoteUpdateRequest(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    requestId: 'request-1',
    createdAt: 1_762_000_000_000,
    transportMode: 'hosted_happier_relay',
    activityKey: {
      serverId: 'server-1',
      sessionId: 'session-1',
      activityName: 'HappierFocusLiveActivity',
    },
    event: 'update',
    snapshotFingerprint: 'snapshot-fingerprint-1',
    contentState: createContentState(),
    ...overrides,
  };
}

describe('Live Activity remote update protocol', () => {
  it('accepts versioned update and end requests for the Happier Focus Live Activity only', async () => {
    const remoteUpdates = await loadRemoteUpdatesModule();
    expect(remoteUpdates).not.toBeNull();
    if (!remoteUpdates) return;

    expect(remoteUpdates.LiveActivityRemoteUpdateRequestV1Schema.safeParse(
      createRemoteUpdateRequest(),
    ).success).toBe(true);

    expect(remoteUpdates.LiveActivityRemoteUpdateRequestV1Schema.safeParse(
      createRemoteUpdateRequest({
        event: 'end',
        dismissalAt: 1_762_000_300_000,
      }),
    ).success).toBe(true);

    expect(remoteUpdates.LiveActivityRemoteUpdateRequestV1Schema.safeParse(
      createRemoteUpdateRequest({
        activityKey: {
          serverId: 'server-1',
          sessionId: 'session-1',
          activityName: 'OtherLiveActivity',
        },
      }),
    ).success).toBe(false);
  });

  it('keeps Expo push tokens separate from ActivityKit and hosted relay targets', async () => {
    const remoteUpdates = await loadRemoteUpdatesModule();
    expect(remoteUpdates).not.toBeNull();
    if (!remoteUpdates) return;

    expect(remoteUpdates.LiveActivityRemoteTargetKindSchema.parse('expo_push_token')).toBe('expo_push_token');
    expect(remoteUpdates.LiveActivityRemoteTargetKindSchema.parse('activitykit_update_token'))
      .toBe('activitykit_update_token');
    expect(remoteUpdates.LiveActivityRemoteTargetKindSchema.parse('activitykit_push_to_start_token'))
      .toBe('activitykit_push_to_start_token');
    expect(remoteUpdates.LiveActivityRemoteTargetKindSchema.safeParse('hosted_happier_relay_target').success)
      .toBe(false);
    expect(remoteUpdates.LiveActivityRemoteTargetKindSchema.safeParse('ExponentPushToken[abc]').success)
      .toBe(false);
  });

  it('rejects push-to-start and broadcast-channel events from the Phase 9.5 update path', async () => {
    const remoteUpdates = await loadRemoteUpdatesModule();
    expect(remoteUpdates).not.toBeNull();
    if (!remoteUpdates) return;

    expect(remoteUpdates.LiveActivityRemoteUpdateRequestV1Schema.safeParse(
      createRemoteUpdateRequest({ event: 'start' }),
    ).success).toBe(false);
    expect(remoteUpdates.LiveActivityRemoteUpdateRequestV1Schema.safeParse(
      createRemoteUpdateRequest({ event: 'push_to_start' }),
    ).success).toBe(false);
    expect(remoteUpdates.LiveActivityRemoteUpdateRequestV1Schema.safeParse(
      createRemoteUpdateRequest({ event: 'broadcast_channel' }),
    ).success).toBe(false);
  });

  it('rejects content states that exceed the ActivityKit payload budget', async () => {
    const remoteUpdates = await loadRemoteUpdatesModule();
    expect(remoteUpdates).not.toBeNull();
    if (!remoteUpdates) return;

    expect(remoteUpdates.HappierFocusLiveActivityContentStateV1Schema.safeParse(
      createContentState({ previewText: 'x'.repeat(5_000) }),
    ).success).toBe(false);
  });

  it('accepts maximum-content fixtures only while the encoded content state stays within 4 KB', async () => {
    const remoteUpdates = await loadRemoteUpdatesModule();
    expect(remoteUpdates).not.toBeNull();
    if (!remoteUpdates) return;

    const base = createContentState({
      title: 'T'.repeat(512),
      subtitle: 'S'.repeat(512),
      previewText: 'P'.repeat(512),
      statusText: 'A'.repeat(512),
      labels: {
        title: 'H'.repeat(128),
        openLabel: 'O'.repeat(128),
        inboxLabel: 'I'.repeat(128),
        attentionLabel: 'N'.repeat(128),
      },
    });
    const encodedBytes = new TextEncoder().encode(JSON.stringify(base)).byteLength;

    expect(encodedBytes).toBeLessThanOrEqual(remoteUpdates.LIVE_ACTIVITY_CONTENT_STATE_MAX_BYTES);
    expect(remoteUpdates.HappierFocusLiveActivityContentStateV1Schema.safeParse(base).success).toBe(true);
  });

  it('keeps interruptive alert intent versioned and rejects raw APNs alert fields', async () => {
    const remoteUpdates = await loadRemoteUpdatesModule();
    expect(remoteUpdates).not.toBeNull();
    if (!remoteUpdates) return;

    expect(remoteUpdates.LiveActivityRemoteUpdateRequestV1Schema.safeParse(
      createRemoteUpdateRequest({
        interruptiveAlert: {
          title: 'Approval needed',
          body: 'Open Happier to review the request.',
          sound: 'happier_urgent.wav',
        },
      }),
    ).success).toBe(true);

    expect(remoteUpdates.LiveActivityRemoteUpdateRequestV1Schema.safeParse(
      createRemoteUpdateRequest({
        alert: {
          title: 'Raw APNs alert should not be accepted',
          body: 'No',
        },
      }),
    ).success).toBe(false);
  });

  it('rejects request content whose session does not match the activity key', async () => {
    const remoteUpdates = await loadRemoteUpdatesModule();
    expect(remoteUpdates).not.toBeNull();
    if (!remoteUpdates) return;

    expect(remoteUpdates.LiveActivityRemoteUpdateRequestV1Schema.safeParse(
      createRemoteUpdateRequest({
        contentState: createContentState({ sessionId: 'different-session' }),
      }),
    ).success).toBe(false);
  });

  it('rejects update content that is already stale at request creation', async () => {
    const remoteUpdates = await loadRemoteUpdatesModule();
    expect(remoteUpdates).not.toBeNull();
    if (!remoteUpdates) return;

    expect(remoteUpdates.LiveActivityRemoteUpdateRequestV1Schema.safeParse(
      createRemoteUpdateRequest({
        createdAt: 1_762_000_000_000,
        contentState: createContentState({
          generatedAt: 1_761_999_999_000,
          staleAt: 1_762_000_000_000,
        }),
      }),
    ).success).toBe(false);
  });
});
