import { describe, expect, it, vi } from 'vitest';

const openBrowserSpy = vi.fn(async (_url: string) => {});
vi.mock('@/ui/openBrowser', () => ({ openBrowser: openBrowserSpy }));

const promptInputSpy = vi.fn(async () => '');
vi.mock('@/terminal/prompts/promptInput', () => ({ promptInput: promptInputSpy }));

describe('authenticateClaudeSubscriptionOauth', () => {
  it('opens the authorization URL using the supported console callback redirect URI', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true as any);
    const { authenticateClaudeSubscriptionOauth } = await import('./authenticateClaudeSubscriptionOauth');

    await expect(authenticateClaudeSubscriptionOauth({ paste: true })).rejects.toThrow();

    expect(openBrowserSpy).toHaveBeenCalledTimes(1);
    const url = String(openBrowserSpy.mock.calls[0]?.[0] ?? '');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://platform.claude.com/oauth/code/callback');
    expect(parsed.searchParams.get('scope')).toBe('user:inference user:profile');

    stdoutSpy.mockRestore();
  });
});
