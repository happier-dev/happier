/** Reads the organization from an Azure DevOps legacy host. */
export function readVisualStudioOrganization(host: string): string | null {
  const suffix = '.visualstudio.com';
  if (!host.endsWith(suffix) || host === suffix.slice(1)) return null;
  const organization = host.slice(0, -suffix.length);
  return organization && !organization.includes('.') ? organization : null;
}
