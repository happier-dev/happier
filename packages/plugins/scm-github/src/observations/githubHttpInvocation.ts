import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';

/** The finite GitHub HTTP owner consumes the same ports in either host. */
export type GithubHttpInvocationContextV1 = Pick<PluginInvocationContext, 'plugin' | 'signal' | 'invokedAtMs' | 'requestId'> & Readonly<{
  /** The portable artifact's existing activation lifetime, independent of invocation ports. */
  githubRequestLifetime?: object;
  services: Readonly<{
    http: PluginInvocationContext['services']['http'];
    connectedAccounts: Pick<PluginInvocationContext['services']['connectedAccounts'],
      'getBinding' | 'materialize' | 'materializeListedAccount'>;
  }>;
}>;
