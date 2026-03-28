import { describe, expect, it, vi } from 'vitest';

import { runChannelBridgeDoctorSection } from './channelBridgesDoctor';

describe('runChannelBridgeDoctorSection', () => {
  it('treats webhook enabled with missing secret as a critical failure', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await runChannelBridgeDoctorSection({
        credentialsToken: null,
        settings: {
          channelBridge: {
            providers: {
              telegram: {
                secrets: {
                  botToken: 'bot-token',
                  webhookSecret: '',
                },
                webhook: {
                  enabled: true,
                  host: '127.0.0.1',
                  port: 8787,
                },
              },
            },
          },
        },
      });

      expect(result.hasCriticalFailures).toBe(true);
      expect(logSpy.mock.calls.map((call) => String(call[0]))).toContain(
        '❌ webhook.enabled=true but webhook.secret is missing (bridge will not start)',
      );
    } finally {
      logSpy.mockRestore();
    }
  });
});
