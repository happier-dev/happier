import { describe, expect, it, vi } from 'vitest';
import { resolveAgyOauthAccount } from './resolveOauthAccount';

describe('AGY account connection', () => {
  it('onboards an eligible account with a project but no current tier', async () => {
    const paths: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      paths.push(String(url));
      if (String(url).includes('userinfo')) return Response.json({ sub: 'a', email: 'a@example.test', email_verified: true });
      if (String(url).includes('onboardUser')) return Response.json({ done: true });
      const loads = paths.filter((path) => path.includes('loadCodeAssist')).length;
      return Response.json({ cloudaicompanionProject: 'project', ...(loads > 1 ? { currentTier: { id: 'free-tier' } } : { allowedTiers: [{ id: 'free-tier' }] }) });
    });
    const result = await resolveAgyOauthAccount({ accessToken: 'token', fetcher });
    expect(paths.some((path) => path.includes('onboardUser'))).toBe(true);
    expect(result.antigravity).toMatchObject({ projectId: 'project', tierId: 'free-tier' });
  });
});
