type LocaleCopyShape<T> = T extends string ? string : T extends (...args: infer Args) => infer Result ? (...args: Args) => Result : T extends object ? { [Key in keyof T]: LocaleCopyShape<T[Key]> } : T;
import type { SupportedLanguage } from '../_all';


declare const githubAccessWords: Record<"ca" | "de" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zhHans" | "zhHant", LocaleCopyShape<typeof githubAccessWordsEnglish.en>>;
declare const oidcEditorWords: Record<"ca" | "de" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zhHans" | "zhHant", LocaleCopyShape<typeof oidcEditorWordsEnglish.en>>;



export type IdentityAdministrationLanguage = Exclude<SupportedLanguage, 'zh-Hans' | 'zh-Hant'> | 'zhHans' | 'zhHant';



export type Words = Readonly<{
    title: string;
    subtitle: string;
    homeConnections: string;
    add: string;
    empty: string;
    unreadable: string;
    active: string;
    disabled: string;
    needsTest: string;
    tested: string;
    staleTest: string;
    configuration: string;
    issuer: string;
    clientId: string;
    clientSecret: string;
    secretSet: string;
    secretNotSet: string;
    secretNeedsAttention: string;
    secretRepair: string;
    secretRetain: string;
    scopes: string;
    loginClaim: string;
    emailClaim: string;
    groupsClaim: string;
    fetchUserInfo: string;
    advanced: string;
    hideAdvanced: string;
    actions: string;
    test: string;
    testing: string;
    validate: string;
    validating: string;
    validated: string;
    edit: string;
    save: string;
    saving: string;
    enable: string;
    disable: string;
    remove: string;
    createTitle: string;
    editTitle: string;
    displayName: string;
    required: string;
    invalidIssuer: string;
    secretRequired: string;
    error: string;
    errorForbidden: string;
    errorConflict: string;
    errorMissing: string;
    errorInUse: string;
    errorProviderUnavailable: string;
    errorRateLimited: string;
    errorInvalid: string;
    errorImmutable: string;
    accounts: string;
    connections: string;
    directoryGroups: string;
    searchGroups: string;
    mapCreate: string;
    mapExisting: string;
    mappedTo: string;
    unmapped: string;
    chooseGroup: string;
    loadMore: string;
    removeMapping: string;
    errorAuthenticationRequired: string;
    errorPolicyUnavailable: string;
    errorPolicyInUse: string;
    errorNotAllowed: string;
    errorNeedsAttention: string;
    /** `Sync now` refused because the source is paused; its recovery is Resume. */
    errorSyncPaused: string;
    alternateLogins: string;
    recoveryAuthenticationPolicy: string;
    recoveryAlternateLogin: string;
    recoveryDirectory: string;
    recoveryGroupMappings: string;
    recoveryTeamAuthentication: string;
    callbackUrl: string;
    callbackUrlHint: string;
}>;



export type GitHubAccessWords = Readonly<{
    githubCurrentAccess: string;
    githubCurrentAccessSubtitle: string;
    githubCurrentAccessEmpty: string;
    githubSetupAccess: string;
    githubSetupAccessSubtitle: string;
    githubRemoveInstallationFor: (params: { name: string }) => string;
}>;



export type OidcEditorWords = Readonly<{
    clientAuthenticationMethod: string;
    clientSecretPost: string;
    clientSecretBasic: string;
    storeRefreshToken: string;
    buttonColor: string;
    iconHint: string;
    allowRulesHint: string;
    brandingHint: string;
    invalidScopes: string;
    refreshFailed: string;
    refreshFailedHint: string;
}>;



export function build(w: Words, github: typeof githubAccessWords[keyof typeof githubAccessWords], oidc: typeof oidcEditorWords[keyof typeof oidcEditorWords]) {
    return {
        identityAdministration: {
            ...w,
            ...github,
            ...oidc,
            workos: 'WorkOS',
            workosSetupSso: `${w.add}: WorkOS SSO`,
            workosSetupDirectory: `${w.add}: WorkOS Directory Sync`,
            workosCheckSetup: `${w.configuration}: WorkOS`,
            workosChooseConnection: `${w.configuration}: WorkOS SSO`,
            providerOidc: 'OpenID Connect',
            providerWorkosSso: 'WorkOS SSO',
            providerGitHub: 'GitHub',
            workosStrategySaml: 'SAML',
            workosStrategyOidc: 'OpenID Connect',
            workosStrategyOther: 'Other sign-in strategy',
            workosStatusUnknown: 'Status unavailable',
            teamRemoveImpact: ({ accounts, alternateLogins, directories, groups, memberships }: { accounts: number; alternateLogins: number; directories: number; groups: number; memberships: number }) => `${w.accounts}: ${accounts}. ${w.alternateLogins}: ${alternateLogins}. Directory: ${directories}. Groups: ${groups}. Managed memberships: ${memberships}.`,
            removeTitle: ({ name }: { name: string }) => `${w.remove}: ${name}?`,
            removeBody: ({ name }: { name: string }) => `${name}: ${w.remove}.`,
            removeBlocked: ({ accounts, connections }: { accounts: number; connections: number }) => `${w.accounts}: ${accounts}. ${w.connections}: ${connections}.`,
            githubApps: 'GitHub Apps',
            githubAppsSubtitle: 'Home-owned GitHub Apps and their verified organization installations.',
            githubAppsEmpty: 'No GitHub Apps configured',
            githubAppAdd: 'Add GitHub App',
            githubAppCreateTitle: 'Add GitHub App',
            githubAppEditTitle: 'Edit GitHub App',
            githubHost: 'GitHub host',
            githubAppId: 'GitHub App ID',
            githubClientId: 'Client ID',
            githubAppSlug: 'App slug',
            githubOwnerLogin: 'Owner login',
            githubPrivateKey: 'Private key',
            githubWebhookSecret: 'Webhook secret',
            githubSecretsRetain: 'Leave secret fields blank to keep their current values.',
            githubInstallations: 'Organization installations',
            githubInstallationsEmpty: 'No verified installations',
            githubOrganization: 'Organization',
            githubRepositorySelection: 'Repository access',
            githubAllRepositories: 'All repositories',
            githubSelectedRepositories: 'Selected repositories',
            githubConsumers: 'Use this App',
            githubConsumersSubtitle: 'Sign-in and directory sync are configured separately after the installation is verified.',
            teamConsumers: 'Team consumers',
            teamConsumersSubtitle: 'Each Team binding enables only the identity or directory facet shown here.',
            githubRequiredAccess: 'Required access',
            githubRequiredAccessSubtitle: 'What the Teams using this App need GitHub to grant. Change the App on GitHub, then verify the installation again.',
            githubRequiredAccessSatisfied: 'This installation already grants everything its Teams need.',
            githubRequiredPermission: ({ level }: { level: string }) => `Permission, ${level}`,
            githubRequiredEvent: 'Webhook event',
            githubRequirementGranted: 'Granted',
            githubRequirementMissing: 'Missing',
            githubFacetSignIn: 'Sign in with GitHub',
            githubFacetSignInSubtitle: 'Choose this installation from the identity connections managed by its owner.',
            githubFacetDirectory: 'Directory sync',
            githubFacetDirectorySubtitle: 'Create a directory source from this verified installation.',
            githubFacetConfigure: 'Configure separately',
            githubVerifyInstallation: 'Verify installation',
            githubInstallationId: 'GitHub installation ID',
            githubOrganizationId: 'GitHub organization ID',
            githubOpeningVerification: 'Opening GitHub verification…',
            githubRemoveInstallation: 'Remove installation',
            githubRemoveInstallationTitle: ({ name }: { name: string }) => `${w.remove}: ${name}?`,
            githubRemoveInstallationBody: ({ name }: { name: string }) => `${name}: ${w.remove}.`,
            githubInstallationInUse: 'This installation is still used by an identity connection or directory source.',
            githubDraft: 'Draft',
            githubVerified: 'Verified',
            githubNeedsAttention: 'Needs attention',
            githubRequired: 'Complete the required GitHub App fields.',
            githubEnterpriseOriginNotApproved: 'This GitHub Enterprise host is not approved by this Home. Your changes are kept here. Open Home Policies, approve the exact HTTPS origin, then return and try again.',
            githubManifestSetup: 'Set up with GitHub',
            githubManifestSetupSubtitle: 'Create and register the App in GitHub, then return here automatically.',
            githubAppName: 'App name',
            githubOrganizationOwner: 'Create for an organization',
            githubOrganizationLogin: 'Organization login',
            githubOpeningSetup: 'Opening GitHub setup…',
            githubManualSetup: 'Manual configuration',
            eligibleProviders: 'Add connection',
            providerOwnerHome: 'Managed by Home',
            providerOwnerTeam: 'Managed by Team',
            providerUnavailable: 'Unavailable',
            providerUseExisting: 'Use connection',
            providerSetup: 'Set up provider',
            providerContactAdmin: 'Contact a Home administrator',
            settingsChangedElsewhere: 'This connection changed on the Home while you were editing. Your changes are kept — review them, then save again.',
            groupsAny: 'Any of these Groups',
            groupsAll: 'All of these Groups',
            disableTitle: ({ name }: { name: string }) => `${w.disable}: ${name}?`,
            disableBody: ({ name }: { name: string }) => `${name}: ${w.disabled}.`,
            diagnosticsTitle: 'Last test result',
            diagnosticsSubject: 'Subject',
            diagnosticsPresent: 'Present',
            diagnosticsMissing: 'Missing',
            diagnosticsLogin: 'Sign-in name',
            diagnosticsEmail: 'Email address',
            diagnosticsProvided: 'Provided',
            diagnosticsNotProvided: 'Not provided',
            diagnosticsEmailVerified: 'Provided and verified',
            diagnosticsEmailUnverified: 'Provided, not verified',
            diagnosticsGroups: 'Groups claim',
            diagnosticsGroupsCount: ({ count }: { count: number }) => `${count} received`,
            diagnosticsGroupsIncomplete: 'Incomplete',
            diagnosticsEligibility: 'Eligibility',
            diagnosticsEligible: 'Eligible',
            diagnosticsIneligible: 'Not eligible',
            diagnosticsNoRules: 'No restrictions configured',
            diagnosticsRuleUsers: 'Allowed users',
            diagnosticsRuleEmailDomains: 'Allowed email domains',
            diagnosticsRuleMatched: 'Matched',
            diagnosticsRuleUnmatched: 'Not matched',
            diagnosticsMappedGroups: 'Mapped Team Groups',
            diagnosticsMappedGroupsEmpty: 'No mapping matched',
            diagnosticsMappedGroupsUnavailable: 'Not evaluated',
            diagnosticsFooter: 'Nothing was changed by this test. No Account, membership, or Group was written.',
        },
    };
}



export const en: Words = {
    title: 'Identity providers', subtitle: 'Home-owned sign-in connections available to Teams.', homeConnections: 'Home sign-in connections', add: 'Add connection', empty: 'No Home sign-in connections', unreadable: 'Some provider records could not be read.', active: 'Active', disabled: 'Disabled', needsTest: 'Test required', tested: 'Tested', staleTest: 'Retest required', configuration: 'Configuration', issuer: 'Issuer URL', clientId: 'Client ID', clientSecret: 'Client secret', secretSet: 'Set', secretNotSet: 'Not set', secretNeedsAttention: 'Needs attention', secretRepair: 'Replace the client secret to repair this connection.', secretRetain: 'Leave blank to keep the current secret.', scopes: 'Scopes', loginClaim: 'Login claim', emailClaim: 'Email claim', groupsClaim: 'Groups claim', fetchUserInfo: 'Fetch UserInfo', advanced: 'Show advanced settings', hideAdvanced: 'Hide advanced settings', actions: 'Actions', test: 'Test sign-in', testing: 'Opening sign-in test…', validate: 'Validate configuration', validating: 'Validating configuration…', validated: 'Configuration valid', edit: 'Edit connection', save: 'Save connection', saving: 'Saving…', enable: 'Enable connection', disable: 'Disable connection', remove: 'Remove connection', createTitle: 'Add identity provider', editTitle: 'Edit identity provider', displayName: 'Name', required: 'Complete the required fields.', invalidIssuer: 'Enter a valid HTTPS issuer URL.', secretRequired: 'Enter a client secret.', error: 'That did not go through. Nothing was changed.', errorForbidden: 'You no longer have permission for this. Nothing was changed.', errorConflict: 'Someone else changed this first. Your edits are kept — reload, then try again.', errorMissing: 'This no longer exists. Someone else may have removed it.', errorInUse: 'Something still depends on this. Remove those first.', errorProviderUnavailable: 'The identity service did not respond. Nothing was changed.', errorRateLimited: 'The provider asked us to wait before trying again.', errorInvalid: 'The Home rejected these values. Check the configuration and try again.', errorImmutable: 'This value is fixed once the record is in use. Create a new one instead.', accounts: 'Affected Accounts', connections: 'Team connections', directoryGroups: 'Directory Groups', searchGroups: 'Search directory Groups', mapCreate: 'Create and manage a Team Group', mapExisting: 'Map to an existing Team Group', mappedTo: 'Mapped to', unmapped: 'Not mapped', chooseGroup: 'Choose a Team Group', loadMore: 'Load more Groups', removeMapping: 'Remove Group mapping', errorAuthenticationRequired: 'Sign in to this Team again, then retry. Nothing was changed.', errorPolicyUnavailable: 'The Team\u2019s authentication policy cannot be evaluated right now. Nothing was changed.', errorPolicyInUse: 'The Team\u2019s authentication policy still depends on this connection.', errorNotAllowed: 'This Home does not let Teams configure this. Nothing was changed.', errorNeedsAttention: 'Directory sync needs attention. Run a full sync.', errorSyncPaused: 'This source is paused. Resume sync to start a fresh full sync.', alternateLogins: 'Accounts needing another way to sign in', recoveryAuthenticationPolicy: 'Open Team authentication', recoveryAlternateLogin: 'Give those Accounts another way to sign in first', recoveryDirectory: 'Open Directory', recoveryGroupMappings: 'Open Group mappings', recoveryTeamAuthentication: 'Sign in again', callbackUrl: 'Callback URL', callbackUrlHint: 'Register this URL with your identity provider.',
};


export const githubAccessWordsEnglish: Pick<Readonly<Record<IdentityAdministrationLanguage, GitHubAccessWords>>, "en"> = { en: {
        githubCurrentAccess: 'Current access',
        githubCurrentAccessSubtitle: 'Required by the enabled connections and directory sources that use this installation.',
        githubCurrentAccessEmpty: 'No access is required by enabled consumers.',
        githubSetupAccess: 'Setup and repair access',
        githubSetupAccessSubtitle: 'Access for configured connections, including disabled connections and paused directory sources. Grant missing access on GitHub before enabling or resuming them, then verify the installation again.',
        githubRemoveInstallationFor: ({ name }: { name: string }) => `Remove installation for ${name}`,
    } };


export const oidcEditorWordsEnglish: Pick<Readonly<Record<IdentityAdministrationLanguage, OidcEditorWords>>, "en"> = { en: {
        clientAuthenticationMethod: 'Client authentication', clientSecretPost: 'POST body', clientSecretBasic: 'HTTP Basic', storeRefreshToken: 'Store refresh token', buttonColor: 'Sign-in button color', iconHint: 'Sign-in icon',
        allowRulesHint: 'Enter one value per line. Leave blank for no restriction.', brandingHint: 'Leave blank to use the default sign-in appearance.', invalidScopes: 'Include openid in the requested scopes.', refreshFailed: 'Couldn’t refresh this connection', refreshFailedHint: 'Your edits are kept. Retry to check for changes on the Home.',
    } };


export const identityAdministrationTranslationsEnglish = { en: build(en, githubAccessWordsEnglish.en, oidcEditorWordsEnglish.en) };