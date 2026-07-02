import { describe, expect, it } from 'vitest';

import { ActivityWebhookPayloadV1Schema, buildActivityWebhookPayload } from './webhookPayload.js';

describe('buildActivityWebhookPayload', () => {
  it('builds a ready webhook payload with session navigation', () => {
    const payload = buildActivityWebhookPayload({
      channelId: 'webhook-primary',
      createdAt: 123,
      topic: 'ready',
      content: {
        title: 'Review branch',
        body: 'The branch is ready to review.',
      },
      session: {
        sessionId: 'session-1',
        title: 'Review branch',
      },
      metadata: {
        providerLabel: 'Codex',
      },
    });

    expect(ActivityWebhookPayloadV1Schema.parse(payload)).toEqual(payload);
    expect(payload.navigation).toEqual({ sessionId: 'session-1' });
  });

  it('builds a request webhook payload without raw input fields', () => {
    const payload = buildActivityWebhookPayload({
      channelId: 'webhook-primary',
      createdAt: 456,
      topic: 'permission_request',
      content: {
        title: 'Deploy fix',
        body: 'Claude asks permission to use Bash\nCommand: git',
      },
      session: {
        sessionId: 'session-2',
        title: 'Deploy fix',
      },
      request: {
        requestId: 'request-1',
        kind: 'permission',
        toolName: 'Bash',
        toolDetails: 'Command: git',
      },
    });

    expect(ActivityWebhookPayloadV1Schema.parse(payload)).toEqual(payload);
    expect(payload.navigation).toEqual({ sessionId: 'session-2', requestId: 'request-1' });
    expect(JSON.stringify(payload)).not.toContain('toolInput');
  });

  it('accepts connected-service quota and account-switch webhook topics', () => {
    for (const topic of [
      'connected_service_account_switch',
      'connected_service_credential_health',
      'connected_service_quota_blocked',
      'connected_service_quota_recovered',
    ] as const) {
      const payload = buildActivityWebhookPayload({
        channelId: 'webhook-primary',
        createdAt: 789,
        topic,
        content: {
          title: 'Provider account updated',
          body: 'A provider account state changed.',
        },
        session: {
          sessionId: 'session-3',
          title: 'Quota recovery',
        },
      });

      expect(ActivityWebhookPayloadV1Schema.parse(payload).topic).toBe(topic);
    }
  });
});
