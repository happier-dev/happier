import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

// axios is the HTTP boundary to the Happier server.
vi.mock('axios');

async function loadOnServer(serverUrl: string) {
  vi.stubEnv('HAPPIER_LOCAL_SERVER_URL', '');
  vi.stubEnv('HAPPIER_PUBLIC_SERVER_URL', '');
  vi.stubEnv('HAPPIER_SERVER_URL', serverUrl);
  await import('@/configuration');
  return await import('./accountPlan');
}

describe('CLI account plan adapters', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('maps a 409 not_a_supporter ring write to a typed refusal', async () => {
    const { putSupporterRing } = await loadOnServer('http://127.0.0.1:41001');
    vi.mocked(axios.put).mockResolvedValue({ status: 409, data: { error: 'not_a_supporter' } });

    await expect(putSupporterRing({ token: 't', visible: true })).resolves.toEqual({ ok: false, errorCode: 'not_a_supporter' });
    expect(String(vi.mocked(axios.put).mock.calls[0]?.[0])).toBe('http://127.0.0.1:41001/v1/account/supporter/ring');
    expect(vi.mocked(axios.put).mock.calls[0]?.[1]).toEqual({ visible: true });
  });

  it('refreshes billing only on Happier Cloud', async () => {
    const selfHosted = await loadOnServer('http://127.0.0.1:41001');
    await expect(selfHosted.postBillingRefresh({ token: 't' })).resolves.toEqual({ ok: false, errorCode: 'billing_refresh_cloud_only' });
    expect(axios.post).not.toHaveBeenCalled();

    vi.resetModules();
    const cloud = await loadOnServer('https://api.happier.dev');
    vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { ok: true } });
    await expect(cloud.postBillingRefresh({ token: 't' })).resolves.toEqual({ ok: true });
    expect(String(vi.mocked(axios.post).mock.calls[0]?.[0])).toBe('https://api.happier.dev/v1/billing/refresh');
  });
});
