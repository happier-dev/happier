import { getProviderCliInstallGuideUrl } from '@happier-dev/agents';

const GEMINI_WORKSPACE_PROJECT_COMMAND = 'happier gemini project set <your-project-id>';

export function buildGeminiWorkspaceProjectGuidanceLines(): ReadonlyArray<string> {
  const setupGuideUrl = getProviderCliInstallGuideUrl('gemini');

  return [
    'Google Workspace accounts require a Google Cloud Project.',
    'If you see "Authentication required" error, set your project ID.',
    '',
    `  ${GEMINI_WORKSPACE_PROJECT_COMMAND}`,
    ...(setupGuideUrl ? ['', `Guide: ${setupGuideUrl}`] : []),
  ];
}

export function buildGeminiWorkspaceProjectAuthenticationMessage(): string {
  return [
    'Authentication required. For Google Workspace accounts, you need to set a Google Cloud Project:',
    `  ${GEMINI_WORKSPACE_PROJECT_COMMAND}`,
    'Or use a different Google account: happier connect gemini',
    ...buildGeminiWorkspaceProjectGuidanceLines().filter((line) => line.startsWith('Guide: ')),
  ].join('\n');
}
