/** Vercel v13 deployment and v9 project target address fields, openapi.vercel.sh,
 * inspected 2026-11-16: url is unique to a deployment; aliasAssigned confirms alias[]. */
export function readVercelDeploymentUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const parsed = new URL(`https://${value}`);
    if (!parsed.username && !parsed.password && parsed.pathname === '/' && !parsed.search && !parsed.hash) return parsed.origin;
  } catch { /* Malformed optional metadata supplies no address fact. */ }
  return undefined;
}

export function projectVercelDeploymentAddresses(value: Readonly<Record<string, unknown>>, production: boolean) {
  const deploymentUrl = readVercelDeploymentUrl(value.url);
  const addresses = !production && deploymentUrl ? { urls: [deploymentUrl] } : {};
  if ((value.aliasAssigned !== true && typeof value.aliasAssigned !== 'number')
    || value.aliasError != null || !Array.isArray(value.alias)) return addresses;
  const builtInUrls = [...new Set(value.alias.flatMap(alias => {
    const url = readVercelDeploymentUrl(alias);
    if (!url || url === deploymentUrl) return [];
    const hostname = new URL(url).hostname;
    return hostname.length > '.vercel.app'.length && hostname.endsWith('.vercel.app') ? [url] : [];
  }))];
  // The unique Production URL can require sign-in while the assigned alias is public.
  return { ...addresses, builtInUrls, ...(production && builtInUrls.length ? { urls: builtInUrls } : {}) };
}
