import {
  defineConnectedAccountDescriptor,
} from '../connectedAccountDescriptors.js';

export const BITBUCKET_CONNECTED_ACCOUNT_DESCRIPTOR = defineConnectedAccountDescriptor({
  id: 'bitbucket',
  kind: 'auth.connectedAccount',
  version: '1',
  displayKey: 'connectedServices.serviceNames.bitbucket',
  aliases: ['bitbucket'],
  credentialKinds: ['token'],
  defaultCredentialKind: 'token',
  connectModes: [
    {
      targetId: 'bitbucket',
      mode: 'token',
      credentialKind: 'token',
      default: true,
      tokenKind: 'api-token',
    },
  ],
  tokenSetup: {
    tokenKind: 'api-token',
    promptLabelKey: 'connectedServices.tokenPrompts.bitbucketApiToken',
    missingValueErrorKey: 'connectedServices.tokenPrompts.errors.missingApiToken',
    setupUrl: 'https://bitbucket.org/account/settings/app-passwords/',
    credentialPayloadKind: 'bitbucket_basic_auth',
    identity: {
      kind: 'email_or_username',
      promptLabelKey: 'connectedServices.tokenPrompts.bitbucketEmailOrUsername',
      missingValueErrorKey: 'connectedServices.tokenPrompts.errors.missingBitbucketEmailOrUsername',
    },
  },
  ui: {
    connectCommand: 'happier connect bitbucket --token',
    oauthAddActionModes: [],
  },
  materialization: {
    materializationKinds: ['scm_hosting_basic_auth'],
    hookKey: 'connectedServices.materialization.bitbucketScmHostingBasicAuth',
  },
  quota: { capabilityIds: [] },
});
