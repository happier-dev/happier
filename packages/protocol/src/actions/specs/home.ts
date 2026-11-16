import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import {
  HomeAccountDeleteResultV1Schema,
  HomeAccountDetailV1Schema,
  HomeAccountListInputV1Schema,
  HomeAccountListResultV1Schema,
  HomeAccountRoleSetInputV1Schema,
  HomeAccountRowV1Schema,
  HomeAccountSearchInputV1Schema,
  HomeAccountSearchResultV1Schema,
  HomeAccountTargetInputV1Schema,
  HomeAccountDeleteInputV1Schema,
  HomePublicProfileHandleReclaimInputV1Schema,
  HomePublicProfileHandleReclaimResultV1Schema,
} from '../../home/governance/accounts.js';
import {
  HomeGovernanceEligibilityGetInputV1Schema,
  HomeGovernanceGetInputV1Schema,
  HomeEmptinessGetInputV1Schema,
} from '../../home/governance/actionsV1.js';
import { HomeGovernancePolicySetInputV1Schema } from '../../home/governance/policy.js';
import {
  HomeGovernanceClaimInputV1Schema,
  HomeGovernanceClaimResultV1Schema,
} from '../../home/governance/claim.js';
import {
  HomeGovernancePolicyProjectionV1Schema,
  HomeGovernanceEligibilityV1Schema,
  HomeGovernanceReadResultV1Schema,
  HomeEmptinessV1Schema,
} from '../../home/governance/projection.js';
import {
  HomeAuditListInputV1Schema,
  HomeAuditListResultV1Schema,
} from '../../home/governance/audit.js';
import {
  HomeMailDeliveryGetInputV1Schema,
  HomeMailDeliveryReadinessV1Schema,
  HomeMailDeliveryTestInputV1Schema,
  HomeMailDeliveryTestResultV1Schema,
  HomeSettingsGetInputV1Schema,
  HomeSettingsProjectionV1Schema,
  HomeSettingsSetInputV1Schema,
} from '../../home/governance/settings.js';
import {
  HomeRetentionDryRunInputV1Schema,
  HomeRetentionDryRunResultV1Schema,
} from '../../home/governance/retention.js';
import {
  HomeReachabilityGetInputV1Schema,
  HomeReachabilityIrohSetInputV1Schema,
  HomeReachabilityV1Schema,
} from '../../home/governance/reachability.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { homeDomainActionRow, homeDomainApprovalField as approvalField } from './homeDomainRow.js';
import { HomePublicProfileModerationInputV1Schema, HomePublicProfileModerationResultV1Schema } from '../../home/governance/publicProfiles.js';
import { SERVER_CONFIG_REGISTRY_BASE } from '../../serverConfig/registry.js';
import { redactObservationInputPaths } from './observationRedaction.js';

const ACCOUNT_ID_FIELD = approvalField('accountId', 'Account ID', { required: true });

/**
 * Home Administration rows.
 *
 * They are core Home behavior, not a gated capability: a Home that understands
 * these operations must serve them whether or not Teams is enabled, because
 * Account status and Home role enforcement are the Home's own authority.
 *
 * Role, Disable and Re-enable answer with the Account row the Home now holds, so
 * a same-state mutation reports the unchanged current Account rather than an
 * acknowledgement the caller would have to re-read to trust.
 */
function createHomeGovernanceActionSpecs() {
  return Object.freeze([
  homeDomainActionRow({
    id: 'home.public_profiles.restrict', approval: { result: 'required', flow: 'deferred' },
    title: 'Restrict a public profile',
    description: 'Remove one Account’s public profile from this Home with an audited reason. The Home rechecks the operator’s authority.',
    safety: 'danger', sideEffectClass: 'danger',
    cliPath: ['home', 'public-profiles', 'restrict'],
    path: '/v1/home/public-profiles/:accountId/restrict',
    inputSchema: HomePublicProfileModerationInputV1Schema,
    outputSchema: HomePublicProfileModerationResultV1Schema,
    inputHints: { fields: [ACCOUNT_ID_FIELD, approvalField('reason', 'Reason', { required: true })] },
  }),
  homeDomainActionRow({
    id: 'home.public_profiles.restore', approval: { result: 'required', flow: 'deferred' },
    title: 'Restore a public profile',
    description: 'Lift one Account’s public-profile restriction with an audited reason. Deleted disclosure is not republished; the Home rechecks the operator’s authority.',
    safety: 'danger', sideEffectClass: 'danger',
    cliPath: ['home', 'public-profiles', 'restore'],
    path: '/v1/home/public-profiles/:accountId/restore',
    inputSchema: HomePublicProfileModerationInputV1Schema,
    outputSchema: HomePublicProfileModerationResultV1Schema,
    inputHints: { fields: [ACCOUNT_ID_FIELD, approvalField('reason', 'Reason', { required: true })] },
  }),
  homeDomainActionRow({
    id: 'home.public_profiles.handle_reclaim', approval: { result: 'required', flow: 'deferred' },
    irreversible: true,
    title: 'Reclaim a public-profile handle',
    description: 'Reclaim the reviewed Account username with an audited reason and owner notice. Any publication restriction remains.',
    safety: 'danger', sideEffectClass: 'danger', cliPath: ['home', 'public-profiles', 'handle-reclaim'],
    path: '/v1/home/public-profiles/:accountId/handle-reclaim',
    inputSchema: HomePublicProfileHandleReclaimInputV1Schema,
    outputSchema: HomePublicProfileHandleReclaimResultV1Schema,
    inputHints: { fields: [ACCOUNT_ID_FIELD,
      approvalField('username', 'Current username', { required: true }),
      approvalField('reason', 'Reason', { required: true }),
      approvalField('notice', 'Notice to the Account owner', { required: true }),
    ] },
  }),
  {
    ...homeDomainActionRow({
      id: 'home.search.rebuild', approval: {result: 'required'}, title: 'Rebuild Home search index',
      approvalPolicy: { uiConfirmation: 'direct' },
      description: 'Rebuild this Personal Home’s derived search index from its canonical transcript rows.',
      safety: 'danger', sideEffectClass: 'danger', cliPath: ['home', 'search', 'rebuild'],
      path: '/v1/home/search/rebuild', inputSchema: HomeGovernanceGetInputV1Schema,
      outputSchema: lazyZodSchema(() => z.strictObject({ ok: z.literal(true) })),
    }),
    // The existing server search owner requires present-user admission.
    requiredAuthority: 'present_user' as const,
  },
  homeDomainActionRow({
    id: 'home.governance.get', approval: {result: 'required'},
    title: 'Get Home administration',
    description: 'Read this Home\'s governance projection for the authenticated Account.',
    safety: 'safe',
    sideEffectClass: 'read',
    cliPath: ['home', 'governance', 'get'],
    path: '/v1/home/governance/get',
    inputSchema: HomeGovernanceGetInputV1Schema,
    outputSchema: HomeGovernanceReadResultV1Schema,
  }),
  homeDomainActionRow({
    id: 'home.governance.eligibility.get', approval: {result: 'required'},
    title: 'Get Home eligibility',
    description: 'Read only Teams availability and this Account\'s effective Team-creation eligibility.',
    safety: 'safe',
    sideEffectClass: 'read',
    cliPath: ['home', 'governance', 'eligibility', 'get'],
    path: '/v1/home/governance/eligibility/get',
    inputSchema: HomeGovernanceEligibilityGetInputV1Schema,
    outputSchema: HomeGovernanceEligibilityV1Schema,
  }),
  homeDomainActionRow({
    id: 'home.emptiness.get', approval: {result: 'required'},
    title: 'Check whether this Home is empty',
    description: 'Read whether this Home has any sessions, other people, Teams or invitations.',
    safety: 'safe',
    sideEffectClass: 'read',
    cliPath: ['home', 'emptiness', 'get'],
    path: '/v1/home/emptiness/get',
    inputSchema: HomeEmptinessGetInputV1Schema,
    outputSchema: HomeEmptinessV1Schema,
  }),
  homeDomainActionRow({
    id: 'home.governance.claim', approval: {result: 'required'},
    irreversible: true,
    title: 'Claim this Home',
    description: 'Become the first owner of an ownerless Home with the one-time code printed by `happier-server --print-home-claim-code`. Every refusal reads the same.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['home', 'governance', 'claim'],
    path: '/v1/home/governance/claim',
    inputSchema: HomeGovernanceClaimInputV1Schema,
    outputSchema: HomeGovernanceClaimResultV1Schema,
    inputHints: { fields: [approvalField('code', 'Claim code', { required: true })] },
  }),
  homeDomainActionRow({
    id: 'home.accounts.list', approval: {result: 'required'},
    title: 'List Home Accounts',
    description: 'Page through the Home People list as a Home administrator.',
    safety: 'safe',
    sideEffectClass: 'read',
    cliPath: ['home', 'accounts', 'list'],
    path: '/v1/home/accounts/list',
    inputSchema: HomeAccountListInputV1Schema,
    outputSchema: HomeAccountListResultV1Schema,
  }),
  homeDomainActionRow({
    id: 'home.accounts.search', approval: {result: 'required'},
    title: 'Search Home Accounts',
    description: 'Resolve people for an exact Home or Team scope without reading Home administration.',
    safety: 'safe',
    sideEffectClass: 'read',
    cliPath: ['home', 'accounts', 'search'],
    path: '/v1/home/accounts/search',
    inputSchema: HomeAccountSearchInputV1Schema,
    outputSchema: HomeAccountSearchResultV1Schema,
    inputHints: { fields: [
      approvalField('query', 'Search query', { required: true }),
      approvalField('scope.kind', 'Scope', { required: true }),
      approvalField('scope.teamId', 'Team ID'),
    ] },
  }),
  homeDomainActionRow({
    id: 'home.accounts.get', approval: {result: 'required'},
    title: 'Get Home Account',
    description: 'Read one person as Home administration sees them: role, status, sign-in facts, Teams, counts and recent administration events.',
    safety: 'safe',
    sideEffectClass: 'read',
    cliPath: ['home', 'accounts', 'get'],
    path: '/v1/home/accounts/get',
    inputSchema: HomeAccountTargetInputV1Schema,
    outputSchema: HomeAccountDetailV1Schema,
    inputHints: { fields: [ACCOUNT_ID_FIELD] },
  }),
  homeDomainActionRow({
    id: 'home.accounts.role.set', approval: {result: 'required'},
    approvalPolicy: { uiConfirmation: 'direct' },
    title: 'Set Home role',
    description: 'Change one Account\'s Home role. The Home enforces its last-owner invariant.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['home', 'accounts', 'role', 'set'],
    path: '/v1/home/accounts/role/set',
    inputSchema: HomeAccountRoleSetInputV1Schema,
    outputSchema: HomeAccountRowV1Schema,
    inputHints: { fields: [
      ACCOUNT_ID_FIELD,
      approvalField('homeRole', 'Home role', { required: true }),
    ] },
  }),
  homeDomainActionRow({
    id: 'home.accounts.disable', approval: {result: 'required'},
    approvalPolicy: { uiConfirmation: 'direct' },
    title: 'Disable Home Account',
    description: 'Place one Account on a reversible hold, ending its access to this Home.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['home', 'accounts', 'disable'],
    path: '/v1/home/accounts/disable',
    inputSchema: HomeAccountTargetInputV1Schema,
    outputSchema: HomeAccountRowV1Schema,
    inputHints: { fields: [ACCOUNT_ID_FIELD] },
  }),
  homeDomainActionRow({
    id: 'home.accounts.enable', approval: {result: 'required'},
    approvalPolicy: { uiConfirmation: 'direct' },
    title: 'Re-enable Home Account',
    description: 'Lift a reversible hold and restore one Account\'s access to this Home.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['home', 'accounts', 'enable'],
    path: '/v1/home/accounts/enable',
    inputSchema: HomeAccountTargetInputV1Schema,
    outputSchema: HomeAccountRowV1Schema,
    inputHints: { fields: [ACCOUNT_ID_FIELD] },
  }),
  homeDomainActionRow({
    id: 'home.accounts.delete', approval: {result: 'required'},
    confirmVerb: { key: 'common.delete', fallback: 'Delete' }, irreversible: true,
    title: 'Delete Home Account',
    description: 'Erase one Account through the Home\'s single erasure owner. Incomplete cleanup is reported explicitly.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['home', 'accounts', 'delete'],
    path: '/v1/home/accounts/delete',
    inputSchema: HomeAccountDeleteInputV1Schema,
    outputSchema: HomeAccountDeleteResultV1Schema,
    accountAuthorityRetirementStatuses: ['deleted', 'disabled_pending_completion'],
    inputHints: { fields: [ACCOUNT_ID_FIELD] },
    approvalPresentation: { summary: () => null, inputHints: { fields: [
      ACCOUNT_ID_FIELD,
      approvalField('managedResourceDispositions', 'Managed resource dispositions', { widget: 'json' }),
    ] } },
  }),
  homeDomainActionRow({
    id: 'home.accounts.signOutEverywhere', approval: {result: 'required'},
    irreversible: true,
    title: 'Sign a Home Account out everywhere',
    description: 'End every signed-in session of one Account. API tokens stay valid until the Account is disabled.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['home', 'accounts', 'sign-out-everywhere'],
    path: '/v1/home/accounts/sign-out-everywhere',
    inputSchema: HomeAccountTargetInputV1Schema,
    outputSchema: HomeAccountRowV1Schema,
    inputHints: { fields: [ACCOUNT_ID_FIELD] },
  }),
  homeDomainActionRow({
    id: 'home.policy.set', approval: {result: 'required'},
    approvalPolicy: {
      uiConfirmation: 'direct',
      // Governance edits are reversible; sign-in widening retains its inline review.
      uiConfirmationForInput: (input) => !HomeGovernancePolicySetInputV1Schema.safeParse(input).success,
    },
    title: 'Set Home policy',
    description: 'Update this Home\'s governance policy against the revision the caller last read.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['home', 'policy', 'set'],
    path: '/v1/home/policy/set',
    inputSchema: HomeGovernancePolicySetInputV1Schema,
    outputSchema: HomeGovernancePolicyProjectionV1Schema,
    inputHints: { fields: [
      approvalField('expectedRevision', 'Expected revision', { widget: 'integer', required: true }),
      approvalField('teamCreationPolicy', 'Team creation policy'),
      approvalField('teamsVisibleToMembers', 'Show Teams to members', { widget: 'boolean' }),
      approvalField('authenticationPolicy.enabledMethodIds', 'Enabled sign-in methods', { widget: 'text_list', listSeparator: 'comma' }),
      approvalField('authenticationPolicy.permittedAccountModes', 'Permitted Account modes', { widget: 'text_list', listSeparator: 'comma' }),
      approvalField('authenticationPolicy.recommendedProvisioningMode', 'Recommended Account mode'),
      approvalField('authenticationPolicy.admission', 'Account admission'),
      approvalField('authenticationPolicy.signInService.mode', 'Sign-in service'),
      approvalField('teamProviderPolicy.allowedTeamProviderKinds', 'Allowed Team provider kinds', { widget: 'text_list', listSeparator: 'comma' }),
      approvalField('teamProviderPolicy.teamJitAllowed', 'Team JIT allowed', { widget: 'boolean' }),
      approvalField('teamProviderPolicy.approvedGitHubEnterpriseOrigins', 'Approved GitHub Enterprise origins', { widget: 'text_list', listSeparator: 'comma' }),
      approvalField('identityNetworkPolicy.mode', 'Identity network mode'),
      approvalField('identityNetworkPolicy.hostnames', 'Allowed hostnames', { widget: 'text_list', listSeparator: 'comma' }),
      approvalField('identityNetworkPolicy.cidrs', 'Allowed CIDRs', { widget: 'text_list', listSeparator: 'comma' }),
      approvalField('identityNetworkPolicy.ports', 'Allowed ports', { widget: 'text_list', listSeparator: 'comma' }),
      approvalField('sessionDefaults', 'Home Session defaults', { widget: 'json' }),
      approvalField('authenticationPolicy.anonymousSignup', 'Anonymous sign-up', { widget: 'boolean' }),
      approvalField('authenticationPolicy.storagePolicy', 'Storage policy'),
      approvalField('confirmWidening', 'Widening confirmed', { widget: 'boolean' }),
    ] },
  }),
  homeDomainActionRow({
    id: 'home.settings.get', approval: {result: 'required'},
    title: 'Get Home settings',
    description: 'Read the effective server configuration of this Home with each value\'s source. Secrets report presence only.',
    safety: 'safe',
    sideEffectClass: 'read',
    cliPath: ['home', 'settings', 'get'],
    path: '/v1/home/settings/get',
    inputSchema: HomeSettingsGetInputV1Schema,
    outputSchema: HomeSettingsProjectionV1Schema,
  }),
  homeDomainActionRow({
    id: 'home.settings.set', approval: {result: 'required'},
    mcp: true,
    approvalPolicy: {
      uiConfirmation: 'direct',
      // Ordinary values are reversible. Write-only secrets and discarded
      // pending restart values cannot be recovered through the settings UI.
      uiConfirmationForInput: (input) => {
        const parsed = HomeSettingsSetInputV1Schema.safeParse(input);
        if (!parsed.success) return true;
        const { values, secrets, discardPendingRestart } = parsed.data;
        const name = values.HAPPIER_HOME_DISPLAY_NAME;
        return (secrets !== undefined && Object.keys(secrets).length > 0) || discardPendingRestart === true
          || Object.keys(values).length === 0
          || (Object.hasOwn(values, 'HAPPIER_HOME_DISPLAY_NAME') && !(typeof name === 'string' || name === null));
      },
    },
    title: 'Set Home settings',
    description: 'Store Home setting values against the revision the caller last read. A deployment env value still wins; restart settings apply at the next server start.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['home', 'settings', 'set'],
    path: '/v1/home/settings/set',
    inputSchema: HomeSettingsSetInputV1Schema,
    outputSchema: HomeSettingsProjectionV1Schema,
    approvalInputCustody: 'live_only',
    projectObservationInput: redactObservationInputPaths('secrets'),
    approvalPresentation: { summary: () => null,
      inputSchema: lazyZodSchema(() => z.omit(HomeSettingsSetInputV1Schema, { secrets: true })),
      projectInput: redactObservationInputPaths('secrets'),
    },
    inputHints: { fields: [
      approvalField('expectedRevision', 'Expected revision', { widget: 'integer', required: true }),
      ...Object.values(SERVER_CONFIG_REGISTRY_BASE).filter(entry => entry.sensitivity === 'secret' && entry.editable === 'home')
        .map(entry => ({ path: `secrets.${entry.key}.replace`, title: entry.key, widget: 'secret' as const, required: true,
          visibleWhen: { op: 'and' as const, all: [
            { op: 'truthy' as const, path: `secrets.${entry.key}` },
            { op: 'not' as const, predicate: { op: 'truthy' as const, path: `secrets.${entry.key}.clear` } },
          ] },
        })),
    ] },
  }),
  homeDomainActionRow({
    id: 'home.mailDelivery.get', approval: {result: 'required'},
    title: 'Get Home mail readiness',
    description: 'Read whether this Home can send mail: a configured transport and a buildable link.',
    safety: 'safe',
    sideEffectClass: 'read',
    cliPath: ['home', 'mail-delivery', 'get'],
    path: '/v1/home/mail-delivery/get',
    inputSchema: HomeMailDeliveryGetInputV1Schema,
    outputSchema: HomeMailDeliveryReadinessV1Schema,
  }),
  homeDomainActionRow({
    id: 'home.mailDelivery.test', approval: {result: 'required'},
    confirmVerb: { key: 'common.send', fallback: 'Send' },
    approvalPolicy: { uiConfirmation: 'direct' },
    title: 'Send a test email',
    description: 'Send a fixed test message through this Home\'s mail settings. A failure reports its class only.',
    safety: 'danger',
    sideEffectClass: 'external',
    cliPath: ['home', 'mail-delivery', 'test'],
    path: '/v1/home/mail-delivery/test',
    inputSchema: HomeMailDeliveryTestInputV1Schema,
    outputSchema: HomeMailDeliveryTestResultV1Schema,
    inputHints: { fields: [approvalField('to', 'Send to', { required: true })] },
  }),
  homeDomainActionRow({
    id: 'home.audit.list', approval: {result: 'required'},
    title: 'List Home administration activity',
    description: 'Page through this Home\'s administration events, newest first, optionally about one target.',
    safety: 'safe',
    sideEffectClass: 'read',
    cliPath: ['home', 'audit', 'list'],
    path: '/v1/home/audit/list',
    inputSchema: HomeAuditListInputV1Schema,
    outputSchema: HomeAuditListResultV1Schema,
  }),
  homeDomainActionRow({
    id: 'home.reachability.get', approval: {result: 'required'},
    title: 'Get how this Home is reached',
    description: 'Read the effective public and web-app addresses with their sources, the hosting computer\'s access method when known, and the direct-connection state.',
    safety: 'safe',
    sideEffectClass: 'read',
    cliPath: ['home', 'reachability', 'get'],
    path: '/v1/home/reachability/get',
    inputSchema: HomeReachabilityGetInputV1Schema,
    outputSchema: HomeReachabilityV1Schema,
  }),
  homeDomainActionRow({
    id: 'home.reachability.iroh.set', approval: {result: 'required'},
    approvalPolicy: {
      uiConfirmation: 'direct',
      // Enable is reversible; disable permanently retires the current identity.
      uiConfirmationForInput: (input) => {
        const parsed = HomeReachabilityIrohSetInputV1Schema.safeParse(input);
        return !parsed.success || parsed.data.mode === 'disabled';
      },
    },
    title: 'Turn direct connections on or off',
    description: 'Turning direct (Iroh) connections off retires the current direct-connection identity for good; turning them on creates a new one. Addresses and sign-ins stay the same.',
    safety: 'danger',
    sideEffectClass: 'danger',
    cliPath: ['home', 'reachability', 'iroh', 'set'],
    path: '/v1/home/reachability/iroh/set',
    inputSchema: HomeReachabilityIrohSetInputV1Schema,
    outputSchema: HomeReachabilityV1Schema,
    inputHints: { fields: [approvalField('mode', 'Direct connections', { required: true })] },
  }),
  homeDomainActionRow({
    id: 'home.retention.dryRun', approval: {result: 'required'},
    title: 'Run a retention dry run',
    description: 'Run one retention sweep of this Home\'s current rules without deleting anything, and report what each domain would delete.',
    safety: 'safe',
    sideEffectClass: 'read',
    cliPath: ['home', 'retention', 'dry-run'],
    path: '/v1/home/retention/dry-run',
    inputSchema: HomeRetentionDryRunInputV1Schema,
    outputSchema: HomeRetentionDryRunResultV1Schema,
  }),
]) satisfies readonly PreNormalizedActionSpec[];
}

export const HOME_GOVERNANCE_ACTION_SPECS: ReturnType<typeof createHomeGovernanceActionSpecs> = lazyActionSpecArray(createHomeGovernanceActionSpecs);
