import { definePlugin } from '@happier-dev/plugin-sdk';
import { TriageSourceCredentialInputsV1, TriageSourceConnectedAccountInputsV1 } from '@happier-dev/triage-protocol/v1';
import { GITHUB_TRIAGE_ACTION_IDS_V1 } from '../../../../../packages/plugins/scm-github/src/triage/contribution';
import { GITHUB_PLUGIN_ID } from '../../../../../packages/plugins/scm-github/src/observations/githubProviderContracts';
import { BITBUCKET_PLUGIN_ID } from '../../../../../packages/plugins/scm-bitbucket/src/bitbucketContracts';
import { BITBUCKET_TRIAGE_ACTION_IDS } from '../../../../../packages/plugins/scm-bitbucket/src/triage/source/descriptor';

const plugin = definePlugin({
    id: 'acme.account-nested-purpose', version: '1.0.0',
    hostAccess: { required: [{ id: 'account-storage', capability: 'storage.account',
        reason: 'Read the configured source in this Account.', scope: { enabled: true } }], optional: [] },
    actions: {
        read: { title: 'Read the configured source', surfaces: ['cli'], dangerLevel: 'safe',
            inputSchema: TriageSourceCredentialInputsV1.listScopeUnits,
            hostAccess: ['account-storage'],
            execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
            run: async (input, context) => context.services.actions.execute({ pluginId: GITHUB_PLUGIN_ID,
                localId: GITHUB_TRIAGE_ACTION_IDS_V1.listScopeUnits }, input),
        },
        scan: { title: 'Scan the configured source', surfaces: ['cli'], dangerLevel: 'safe',
            inputSchema: TriageSourceConnectedAccountInputsV1.scan,
            hostAccess: ['account-storage'],
            execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
            run: async (input, context) => context.services.actions.execute({ pluginId: BITBUCKET_PLUGIN_ID,
                localId: BITBUCKET_TRIAGE_ACTION_IDS.scan }, input),
        },
    },
});

export const manifest = plugin.manifest;
export const activateAccount = plugin.activateAccount;
