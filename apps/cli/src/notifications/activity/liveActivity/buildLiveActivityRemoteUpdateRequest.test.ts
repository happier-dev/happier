import { describe, expect, it } from 'vitest';
import {
  accountSettingsParse,
  LIVE_ACTIVITY_CONTENT_STATE_MAX_BYTES,
  LiveActivityRemoteUpdateRequestV1Schema,
  resolveAttentionDeliveryPolicyDecision,
} from '@happier-dev/protocol';
import { buildLiveActivityRemoteUpdateRequest } from './buildLiveActivityRemoteUpdateRequest';

describe('Live Activity request content budget', () => {
  it.each([['local/personal', 'happier_urgent.wav'], ['chime', 'happier_chime.wav']])(
    'carries the push sound for %s in the ActivityKit alert',
    (soundId, expectedSound) => {
      const now = new Date('2026-05-04T12:00:00.000Z');
      const policy = accountSettingsParse({ attentionDeliveryPolicyV1: {
        sounds: { eventSoundIds: { permission_request: soundId } },
        liveActivityRemoteUpdates: { enabled: true, preferredMode: 'direct_apns' },
      } }).attentionDeliveryPolicyV1;
      const request = buildLiveActivityRemoteUpdateRequest({
        decision: resolveAttentionDeliveryPolicyDecision({ policy, channel: 'live_activity', event: 'permission_request', now }),
        nowMs: now.getTime(), serverId: 'server-a',
        event: { topic: 'permission_request', sessionId: 'session-1', requestId: 'permission-1', toolName: 'Bash' },
      });
      expect(LiveActivityRemoteUpdateRequestV1Schema.safeParse(request).success).toBe(true);
      expect(request).toMatchObject({ interruptiveAlert: { sound: expectedSound } });
    },
  );
  it('does not turn machine alert or recovery notices into Session Live Activities', () => {
    const nowMs = Date.parse('2026-05-04T12:00:00.000Z');
    const policy = accountSettingsParse({ attentionDeliveryPolicyV1: {
      liveActivityRemoteUpdates: { enabled: true, preferredMode: 'direct_apns' },
    } }).attentionDeliveryPolicyV1;
    const decision = resolveAttentionDeliveryPolicyDecision({ policy, channel: 'live_activity', event: 'permission_request', now: new Date(nowMs) });
    expect(decision.delivery).not.toBe('suppress');
    expect(decision.liveActivityRemoteBehavior).toMatchObject({ mode: 'direct_apns', freshness: 'fresh' });
    for (const phase of ['started', 'recovered'] as const) {
      expect(buildLiveActivityRemoteUpdateRequest({ decision, nowMs, serverId: 'server-a',
        event: { topic: 'resource_limit', kind: 'memory_pressure', phase, machineId: 'machine-1',
          at: nowMs, since: nowMs - 120_000, guardEnabled: false,
          evidence: { level: 'elevated', sustainMs: 120_000 } },
      })).toBeNull();
    }
  });
  it('preserves a routable update for long Unicode request previews and alert text', () => {
    const nowMs = Date.parse('2026-05-04T12:00:00.000Z');
    const policy = accountSettingsParse({ attentionDeliveryPolicyV1: {
      channels: { live_activity: { events: { permission_request: { previewBehavior: 'include_preview' } } } },
      liveActivityRemoteUpdates: { enabled: true, preferredMode: 'direct_apns' },
    } }).attentionDeliveryPolicyV1;
    const request = buildLiveActivityRemoteUpdateRequest({
      decision: resolveAttentionDeliveryPolicyDecision({ policy, channel: 'live_activity', event: 'permission_request', now: new Date(nowMs) }),
      nowMs, serverId: 'server-a', requestId: 'notification-1',
      event: { topic: 'permission_request', sessionId: 'session-1', requestId: 'permission-1',
        sessionTitle: '项目🚀'.repeat(100), toolName: 'Bash', toolInput: { command: 'echo ' + '🚀"\\'.repeat(3000) } },
    });
    expect(request).not.toBeNull();
    expect(LiveActivityRemoteUpdateRequestV1Schema.safeParse(request).success).toBe(true);
    expect(request?.activityKey).toMatchObject({ serverId: 'server-a', sessionId: 'session-1' });
    expect(request?.contentState?.sessionTarget).toContain('session-1');
    expect(Buffer.byteLength(JSON.stringify(request?.contentState), 'utf8')).toBeLessThanOrEqual(LIVE_ACTIVITY_CONTENT_STATE_MAX_BYTES);
    expect(request?.contentState?.previewText).toContain('echo');
    expect(request?.contentState?.previewText).toContain('…');
    if (request?.event === 'update') {
      expect(request.interruptiveAlert?.title.length).toBeLessThanOrEqual(120);
      expect(request.interruptiveAlert?.body.length).toBeLessThanOrEqual(240);
    }
  });
});
