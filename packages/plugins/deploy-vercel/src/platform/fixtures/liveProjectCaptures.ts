/**
 * Live Vercel captures from COR4B-VERCEL-1115 (2026-11-15, team-scoped REST API):
 * the GitHub `link` of a project made by POST /v11/projects with `gitRepository`
 * (.project/tmp/COR4B-VERCEL-1115/p-project.json) and the first POST
 * /v13/deployments refusal for a new project without projectSettings
 * (probe-project-settings.json). The credential id is replaced; shapes are verbatim.
 */
export const liveCreatedProjectGitLink = {
  type: 'github',
  repo: 'triage-qa-sandbox',
  repoId: 1424792902,
  org: 'happier-dev',
  repoOwnerId: 258441704,
  gitCredentialId: 'cred_fixture',
  productionBranch: 'main',
  createdAt: 1794770145041,
  updatedAt: 1794770145041,
  deployHooks: [],
} as const;

export const liveMissingProjectSettingsRefusal = {
  error: {
    code: 'missing_project_settings',
    message:
      'The `projectSettings` object is required for new projects, but is missing in the deployment payload. If you want to use automatic framework detection, you can use the `skipAutoDetectionConfirmation=1` query parameter.',
    framework: {
      name: 'Other',
      slug: null,
      description: 'No framework or an unoptimized framework.',
    },
    projectSettings: {
      createdAt: 1794770767672,
      devCommand: null,
      installCommand: null,
      buildCommand: null,
      outputDirectory: null,
      rootDirectory: null,
      framework: null,
    },
  },
} as const;
