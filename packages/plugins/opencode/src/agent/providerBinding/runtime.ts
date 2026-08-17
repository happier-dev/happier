import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';

import { OPENCODE_PROVIDER_CONFIG_RELATIVE_PATH } from './adapter.js';

export async function readOpenCodeProviderConfigContent(
  request: AgentSessionOpenRequest,
): Promise<string | undefined> {
  const materialization = request.providerBinding?.materialization;
  if (materialization === undefined) return undefined;
  if (
    materialization.kind !== 'configFile'
    || materialization.relativePaths.length !== 1
    || materialization.relativePaths[0] !== OPENCODE_PROVIDER_CONFIG_RELATIVE_PATH
  ) {
    throw new Error('OpenCode Provider binding requires its canonical config-file materialization');
  }
  return readFile(
    join(materialization.rootPath, OPENCODE_PROVIDER_CONFIG_RELATIVE_PATH),
    'utf8',
  );
}

export async function withOpenCodeProviderConfigLaunchEnvironment(
  request: AgentSessionOpenRequest,
): Promise<AgentSessionOpenRequest> {
  const providerConfigContent = await readOpenCodeProviderConfigContent(request);
  if (providerConfigContent === undefined) return request;
  return {
    ...request,
    launchEnvironment: {
      values: {
        ...(request.launchEnvironment?.values ?? {}),
        OPENCODE_CONFIG_CONTENT: providerConfigContent,
      },
      unset: (request.launchEnvironment?.unset ?? [])
        .filter((key) => key !== 'OPENCODE_CONFIG_CONTENT'),
    },
  };
}
