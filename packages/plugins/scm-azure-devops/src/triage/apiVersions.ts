/**
 * Pinned Azure DevOps REST `api-version` values, one per resource this source reads.
 *
 * Azure DevOps serves a *different contract* per `api-version`, and omitting the parameter
 * lets the server pick. Every URL this source builds therefore carries a pinned value from
 * this table, so the served contract is a fact of the build rather than a server default.
 *
 * REST 7.1 sets the Azure DevOps Server floor (Server 2022.1, build >= 19.225.34309.2).
 * A configured Server that cannot serve 7.1 is reported as unsupported; it is never sent a
 * speculative mixture of 7.1 and whatever it happens to accept.
 */
export const AZURE_DEVOPS_API_VERSIONS = {
  /**
   * Identity/health read used to resolve the viewer GUID and the observed deployment.
   * Preview-pinned deliberately: `connectionData` is not published in the 7.1 GA resource
   * index, so this value is unverified against a live account and is recorded as such.
   */
  connectionData: '7.1-preview.1',
  projects: '7.1',
  repositories: '7.1',
  pullRequests: '7.1',
  pullRequest: '7.1',
  iterations: '7.1',
  iterationChanges: '7.1',
  threads: '7.1',
  commits: '7.1',
  statuses: '7.1',
  policyEvaluations: '7.1-preview.1',
} as const satisfies Readonly<Record<string, string>>;

export type AzureDevOpsResource = keyof typeof AZURE_DEVOPS_API_VERSIONS;

/**
 * The lowest REST version this vertical is built against. A configured Azure DevOps Server
 * that cannot prove this floor is reported `edition_unsupported` before scan or detail.
 */
export const AZURE_DEVOPS_REST_FLOOR = '7.1' as const;
