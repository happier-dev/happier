import type { PluginDisposable } from '@happier-dev/plugin-sdk';

import { BITBUCKET_SCM_HOSTING_PROVIDER_ID } from './adapter.js';
import {
  BITBUCKET_SCM_HOSTING_BASIC_AUTH_MATERIALIZATION_HOOK_KEY,
  materializeBitbucketScmHostingBasicAuth,
} from './auth/basicAuthMaterializer.js';
import { bitbucketApiAdapter } from './operations/bitbucketApiAdapter.js';

type ScmHostingProviderActivationApi = Readonly<{
  registerScmHostingProvider(registration: Readonly<{
    id: string;
    adapter: Readonly<Record<string, unknown>>;
  }>): PluginDisposable;
  registerHook(registration: Readonly<{
    hookId: string;
    priority?: number;
    category?: 'integration';
    scope?: 'plugin';
    executionKind?: 'integrate';
    handler: (request: unknown) => unknown;
  }>): PluginDisposable;
}>;

export function activate(api: ScmHostingProviderActivationApi): void {
  api.registerScmHostingProvider({
    id: BITBUCKET_SCM_HOSTING_PROVIDER_ID,
    adapter: bitbucketApiAdapter,
  });
  api.registerHook({
    hookId: BITBUCKET_SCM_HOSTING_BASIC_AUTH_MATERIALIZATION_HOOK_KEY,
    category: 'integration',
    scope: 'plugin',
    executionKind: 'integrate',
    handler: (request) => materializeBitbucketScmHostingBasicAuth(
      request as Parameters<typeof materializeBitbucketScmHostingBasicAuth>[0],
    ),
  });
}
