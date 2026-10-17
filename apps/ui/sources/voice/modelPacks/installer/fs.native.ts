import type { InstallerFs, InstallerOverrides } from './types';

export async function getFs(overrides: InstallerOverrides): Promise<InstallerFs> {
  if (overrides.fs) return overrides.fs;
  const fs = await import('expo-file-system');
  return fs;
}

// This transport fetches small JSON manifests; artifact downloads go directly to native files.
const manifestFetch: typeof fetch = async (input, init) => {
  const { fetch: expoFetch } = await import('expo/fetch');
  // Boundary cast: expo's FetchResponse implements the Response members the installer uses.
  return (await expoFetch(String(input), init as Parameters<typeof expoFetch>[1])) as unknown as Response;
};

export function getFetch(overrides: InstallerOverrides): typeof fetch {
  return overrides.fetch ?? manifestFetch;
}
