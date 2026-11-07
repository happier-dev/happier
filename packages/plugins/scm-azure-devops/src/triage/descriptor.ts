import { azureDetailTabDeclaration } from '../ui/detail/tabDeclarations.js';
import type { TriageSourceDescriptorV1 } from '@happier-dev/triage-protocol/v1';

/**
 * The declared Connected Account purpose this source enumerates and materializes.
 *
 * `sources/SCM.md` §6.1: the Azure resolution is an `azure-devops-account` descriptor holding
 * the exact configured service organization base or Azure DevOps Server collection base plus a
 * PAT. The source never reads a token from settings, from an `az` profile, or from a caller.
 */
export const AZURE_DEVOPS_TRIAGE_PURPOSE = 'azure-devops-account-use';

/**
 * The Connected Account descriptor this purpose is scoped to.
 *
 * It is the local id every `hostAccess` reference resolves against, so it is declared once here
 * and read from here by the manifest, the runtime and every conformance check. It is deliberately
 * a different string from the purpose above: a purpose is a `hostAccess` request id and a
 * descriptor is a contributed service, they share one plugin-local id namespace, and reusing one
 * string for both makes the manifest unbuildable.
 */
export const AZURE_DEVOPS_CONNECTED_ACCOUNT_ID = 'azure-devops-account';

/**
 * The public SCM-provider network host-access request.
 *
 * Azure DevOps Services and the fixed provider origins remain public-only. The configured-account
 * origin has a separate request below because `privateNetwork` is scope-level and must not widen
 * this public target when a Server deployment is configured on a private network.
 */
export const AZURE_DEVOPS_NETWORK_HOST_ACCESS_ID = 'azure-devops-api';

/** The network host-access request for the exact configured Azure DevOps account origin. */
export const AZURE_DEVOPS_ACCOUNT_NETWORK_HOST_ACCESS_ID = 'azure-devops-account-api';

/**
 * Azure ships pull requests only. Azure Boards Work Items are a separate product domain with
 * their own types, states, hierarchy and query language (`sources/SCM.md` §6.3), so this source
 * declares no `issue` kind rather than projecting one lossily.
 */
export const AZURE_DEVOPS_TRIAGE_KIND_ID = 'pull-request';

/** `PluginContributionLocalIdSchema` spelling of this plugin's one Triage contribution. */
export const AZURE_DEVOPS_TRIAGE_CONTRIBUTION_ID = 'azure-devops-forge';

export const AZURE_DEVOPS_TRIAGE_DETAIL_RENDERER_ID = 'triage-pull-request-detail';

/**
 * The built UI artifact the detail renderer mounts. The SDK UI build resolves it
 * through the package's exact `./happier-plugin-ui/<artifactId>` export and fails
 * the build when that export is missing.
 */
export const AZURE_DEVOPS_TRIAGE_DETAIL_ARTIFACT_ID = 'azure-devops-detail-native';
/**
 * The source-owned Settings page a person uses to put Azure DevOps into PRs & Issues,
 * and the artifact that mounts it.
 *
 * It is a plain Settings contribution: the generic Settings catalog owns the
 * group, route and availability decision, and this source supplies one page and
 * one renderer. The page is the only production caller of the target-owned
 * `happier.triage/sources/administer-v1` Action for this source, and without it
 * every configured-instance path in this package is unreachable from the
 * product.
 */
export const AZURE_DEVOPS_TRIAGE_SETTINGS_GROUP_ID = 'azure-devops-triage';
export const AZURE_DEVOPS_TRIAGE_SETTINGS_PAGE_ID = 'triage-sources';
export const AZURE_DEVOPS_TRIAGE_SETTINGS_RENDERER_ID = 'azure-devops-triage-sources';
export const AZURE_DEVOPS_TRIAGE_SETTINGS_ARTIFACT_ID = 'azure-devops-triage-sources-native';


export const AZURE_DEVOPS_TRIAGE_DESCRIPTOR = {
  v: 1,
  purpose: AZURE_DEVOPS_TRIAGE_PURPOSE,
  // The page this source's own Settings contribution ships, so the PRs & Issues
  // surface can offer a working Configure action rather than naming Settings and
  // leaving the reader to find it. A BARE local id: the target qualifies it with the
  // contributor identity the host already admitted.
  settingsPageId: AZURE_DEVOPS_TRIAGE_SETTINGS_PAGE_ID,
  displayName: 'Azure DevOps',
  kinds: [{
    id: AZURE_DEVOPS_TRIAGE_KIND_ID,
    workflowSubject: 'pullRequest',
    displayName: 'Pull request',
    pluralDisplayName: 'Pull requests',
    // r0.42: the Triage detail frame draws these tabs and asks this source for
    // each as a panel; the writes render as the header `actions` panel.
    detailTabs: [
      { kind: 'shared', id: 'overview', scrollOwner: azureDetailTabDeclaration('overview').scrollOwner },
      { kind: 'shared', id: 'activity', scrollOwner: azureDetailTabDeclaration('activity').scrollOwner },
      { kind: 'shared', id: 'files', scrollOwner: azureDetailTabDeclaration('files').scrollOwner },
      { kind: 'shared', id: 'checks', scrollOwner: azureDetailTabDeclaration('policies').scrollOwner },
    ],
    detailActions: true,
  }],
} as const satisfies TriageSourceDescriptorV1;
