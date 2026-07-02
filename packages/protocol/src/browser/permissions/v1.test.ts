import { describe, expect, it } from 'vitest';

type BrowserPermissionsModule = typeof import('./v1.js');

async function loadBrowserPermissionsModule(): Promise<BrowserPermissionsModule | null> {
  return import('./v1.js').catch(() => null);
}

describe('browser permissions v1 protocol', () => {
  it('serializes scoped browser permissions without provider-specific branches', async () => {
    const mod = await loadBrowserPermissionsModule();

    const result = mod?.BrowserPermissionsV1Schema.safeParse({
      profileId: 'browser_profile_1',
      grants: [
        {
          id: 'grant_1',
          origin: 'https://preview.example.test',
          permission: 'downloads',
          state: 'allowed',
          scope: 'target',
          targetId: 'preview_123',
          updatedAt: 1_000,
        },
      ],
    });

    expect(result?.success).toBe(true);
  });

  it('rejects executable or chrome-control permissions from the shared protocol', async () => {
    const mod = await loadBrowserPermissionsModule();

    const result = mod?.BrowserPermissionsV1Schema.safeParse({
      profileId: 'browser_profile_1',
      grants: [
        {
          id: 'grant_1',
          origin: 'https://preview.example.test',
          permission: 'browserChromeControl',
          state: 'allowed',
          scope: 'target',
          targetId: 'preview_123',
          updatedAt: 1_000,
        },
      ],
    });

    expect(result?.success).toBe(false);
  });

  it('rejects non-http origins for browser permission grants', async () => {
    const mod = await loadBrowserPermissionsModule();

    const result = mod?.BrowserPermissionsV1Schema.safeParse({
      profileId: 'browser_profile_1',
      grants: [
        {
          id: 'grant_1',
          origin: 'javascript:alert(1)',
          permission: 'downloads',
          state: 'allowed',
          scope: 'profile',
          updatedAt: 1_000,
        },
      ],
    });

    expect(result?.success).toBe(false);
  });

  it('rejects page URLs where browser permission grants require origins', async () => {
    const mod = await loadBrowserPermissionsModule();

    const result = mod?.BrowserPermissionsV1Schema.safeParse({
      profileId: 'browser_profile_1',
      grants: [
        {
          id: 'grant_1',
          origin: 'https://preview.example.test/settings',
          permission: 'downloads',
          state: 'allowed',
          scope: 'profile',
          updatedAt: 1_000,
        },
      ],
    });

    expect(result?.success).toBe(false);
  });

  it('requires a target id for target-scoped browser permission grants', async () => {
    const mod = await loadBrowserPermissionsModule();

    const result = mod?.BrowserPermissionsV1Schema.safeParse({
      profileId: 'browser_profile_1',
      grants: [
        {
          id: 'grant_1',
          origin: 'https://preview.example.test',
          permission: 'downloads',
          state: 'allowed',
          scope: 'target',
          updatedAt: 1_000,
        },
      ],
    });

    expect(result?.success).toBe(false);
  });
});
