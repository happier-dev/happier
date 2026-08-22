import { beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.hoisted(() => vi.fn());
vi.mock('axios', () => ({ default: { post } }));
vi.mock('@/session/transport/http/serverHttpBaseUrl', () => ({
  resolveServerHttpBaseUrl: () => 'https://api.example.test',
}));

describe('runAutomationNow', () => {
  beforeEach(() => post.mockReset());

  it('uses the V3 run-now owner and sends the caller occurrence identity', async () => {
    post.mockResolvedValue({
      status: 200,
      data: { run: { id: 'run-1', automationId: 'automation-1', state: 'queued' } },
    });
    const { runAutomationNow } = await import('./automations');

    await expect(runAutomationNow({
      token: 'token-1',
      automationId: 'automation/1',
      idempotencyKey: 'ci-build-42',
    })).resolves.toEqual(expect.objectContaining({ id: 'run-1' }));

    expect(post).toHaveBeenCalledWith(
      'https://api.example.test/v3/automations/automation%2F1/run-now',
      undefined,
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer token-1',
          'Idempotency-Key': 'ci-build-42',
        },
      }),
    );
  });
});
