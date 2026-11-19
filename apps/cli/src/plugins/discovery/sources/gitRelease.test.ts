import { describe, expect, it } from 'vitest';

import { resolvePluginGitRelease } from './gitRelease';

const locator = 'https://github.com/example/plugin';

describe('Git plugin release selection', () => {
  it('selects a current release tag every time, and uses HEAD only when GitHub reports no release', async () => {
    const responses = [Response.json({ tag_name: 'v1' }), Response.json({ tag_name: 'v2' }), new Response(null, { status: 404 })];
    const fetchImpl = async () => responses.shift()!;
    await expect(resolvePluginGitRelease(locator, { fetchImpl })).resolves.toBe('v1');
    await expect(resolvePluginGitRelease(locator, { fetchImpl })).resolves.toBe('v2');
    await expect(resolvePluginGitRelease(locator, { fetchImpl })).resolves.toBeUndefined();
    await expect(resolvePluginGitRelease(locator, { fetchImpl: async () => new Response(null, { status: 403 }) })).rejects.toThrow();
  });
});
