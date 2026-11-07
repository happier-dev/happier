import { lazyActionSpecArray } from '../../lazyActionSpecValue.js';
import { AccountHistoricalEncryptionKeyForgetInputV1Schema, AccountHistoricalEncryptionKeyForgetResultV1Schema, AccountEncryptionAutomationTemplatesRecoverInputV1Schema, AccountEncryptionAutomationTemplatesRecoverResultV1Schema } from '../../../auth/accountSecurity.js';
import { ACCOUNT_EMAIL_CHANGE_REQUEST_PATH_V1, ACCOUNT_PASSWORD_CHANGE_PATH_V1, ACCOUNT_PASSWORD_ENROLL_PATH_V1, ACCOUNT_PASSWORD_REMOVE_PATH_V1, ACCOUNT_SECURITY_PATH_V1 } from '../../../auth/accountSecurity.js';
import { PluginAccountDataEraseActionInputV1Schema, PluginAccountDataEraseActionOutputV1Schema } from '../../../plugins/data/accountEraseV1.js';
import { AccountSessionsSignOutEverywhereActionInputV1Schema, AccountSessionsSignOutEverywhereActionOutputV1Schema } from '../../../auth/accountSessions.js';
import { AccountEmailChangeRequestResponseV1Schema, AccountEmailChangeRequestV1Schema, AccountPasswordChangeRequestV1Schema, AccountPasswordEnrollRequestV1Schema, AccountPasswordMutationResponseV1Schema, AccountPasswordRemoveRequestV1Schema, AccountSecurityGetRequestV1Schema, AccountSecurityGetResponseV1Schema } from '../../../auth/accountSecurity.js';
import { ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1, ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1, ACCOUNT_API_TOKENS_REVOKE_ALL_HTTP_PATH_V1, ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1, ACCOUNT_API_TOKENS_UPDATE_HTTP_PATH_V1, AccountApiTokensUpdateActionInputV1Schema, AccountApiTokensUpdateActionOutputV1Schema, AccountApiTokensCreateActionInputV1Schema, AccountApiTokensCreateActionOutputV1Schema, projectAccountApiTokenCreationObservation, AccountApiTokensListActionInputV1Schema, AccountApiTokensListActionOutputV1Schema, AccountApiTokensRevokeActionInputV1Schema, AccountApiTokensRevokeActionOutputV1Schema, AccountApiTokensRevokeAllActionInputV1Schema, AccountApiTokensRevokeAllActionOutputV1Schema } from '../../../auth/accountApiTokens.js';
import type { PreNormalizedActionSpec } from '../definition.js';


function createAccountSecurityActionSpecs() {
  return Object.freeze([
  {
    id: 'account.plugins.data.erase', executionPlacement: 'account', approval: {result: 'required'},
    irreversible: true,
    title: 'Erase Account plugin data',
    description: 'Erase the current Account’s retained data for one plugin without uninstalling local plugin code.',
    safety: 'danger',
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
    },
    sideEffectClass: 'danger',
    outputSchema: PluginAccountDataEraseActionOutputV1Schema,
    inputSchema: PluginAccountDataEraseActionInputV1Schema,
    inputHints: {
      title: 'Erase Account plugin data',
      description: 'This permanently removes the current Account’s retained data for the selected plugin.',
      fields: [
        { path: 'pluginId', title: 'Plugin id', widget: 'text', required: true },
      ],
    },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'account.sessions.signOutEverywhere', executionPlacement: 'account', approval: {result: 'required'},
    accountAuthorityRetirementStatuses: ['signed_out'],
    title: 'Sign out everywhere',
    description: 'Invalidate all signed sessions for the current Account. API tokens remain active.',
    safety: 'danger',
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
    },
    sideEffectClass: 'danger',
    outputSchema: AccountSessionsSignOutEverywhereActionOutputV1Schema,
    inputSchema: AccountSessionsSignOutEverywhereActionInputV1Schema,
    inputHints: {
      title: 'Sign out everywhere',
      description: 'This invalidates signed sessions for the current Account. API tokens remain active.',
      fields: [],
    },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'account.encryption.automationTemplates.recover', executionPlacement: 'client', approval: {result: 'required'},
    placements: [],
    bindings: { mcpToolName: 'account_encryption_automation_templates_recover' },
    title: 'Recover older automation templates',
    description: 'Recover encrypted predecessor templates on a plain Account using genuine historical material held by the invoking client. Each template uses version CAS; retained encrypted Session templates and historical keys remain unchanged.',
    safety: 'danger',
    sideEffectClass: 'write',
    requiredAuthority: 'present_user',
    surfaces: { ui: true, voice: false, mcp: true, cli: false, agent: true, rpc: false },
    inputSchema: AccountEncryptionAutomationTemplatesRecoverInputV1Schema,
    outputSchema: AccountEncryptionAutomationTemplatesRecoverResultV1Schema,
    inputHints: { title: 'Recover older automation templates', fields: [] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'account.encryption.historicalKey.forget', executionPlacement: 'client', approval: {result: 'required'},
    confirmVerb: { key: 'common.remove', fallback: 'Remove' }, irreversible: true,
    placements: [],
    bindings: { mcpToolName: 'account_encryption_historical_key_forget' },
    title: 'Forget the old encryption key',
    description: 'Irreversibly discard historical encryption material on the invoking device after disclosing encrypted dependencies and obtaining human confirmation. Server content is not deleted.',
    safety: 'danger',
    sideEffectClass: 'danger',
    requiredAuthority: 'present_user',
    surfaces: { ui: true, voice: false, mcp: true, cli: false, agent: true, rpc: false },
    inputSchema: AccountHistoricalEncryptionKeyForgetInputV1Schema,
    outputSchema: AccountHistoricalEncryptionKeyForgetResultV1Schema,
    inputHints: { title: 'Forget the old encryption key', fields: [] },
  } satisfies PreNormalizedActionSpec,
  ...(([
    {
      id: 'account.security.get', executionPlacement: 'account', approval: {result: 'required'},
      bindings: { mcpToolName: 'account_security_get' },
      title: 'View Account security',
      description: 'Read the current Account authentication summary without exposing credential material.',
      safety: 'safe',
      sideEffectClass: 'read',
      inputSchema: AccountSecurityGetRequestV1Schema,
      outputSchema: AccountSecurityGetResponseV1Schema,
      serverTransport: { method: 'GET', path: ACCOUNT_SECURITY_PATH_V1 },
    },
    {
      id: 'account.password.enroll', executionPlacement: 'account', approval: {result: 'required'},
      title: 'Add a password',
      description: 'Enroll email and password authentication for the current Account.',
      safety: 'danger',
      sideEffectClass: 'danger',
      inputSchema: AccountPasswordEnrollRequestV1Schema,
      outputSchema: AccountPasswordMutationResponseV1Schema,
      serverTransport: { method: 'POST', path: ACCOUNT_PASSWORD_ENROLL_PATH_V1 },
    },
    {
      id: 'account.password.change', executionPlacement: 'account', approval: {result: 'required'},
      title: 'Change password',
      description: 'Replace the current Account password credential.',
      safety: 'danger',
      sideEffectClass: 'danger',
      inputSchema: AccountPasswordChangeRequestV1Schema,
      outputSchema: AccountPasswordMutationResponseV1Schema,
      serverTransport: { method: 'POST', path: ACCOUNT_PASSWORD_CHANGE_PATH_V1 },
    },
    {
      id: 'account.password.remove', executionPlacement: 'account', approval: {result: 'required'},
      irreversible: true,
      title: 'Remove password',
      description: 'Remove email and password authentication after verifying another viable sign-in route.',
      safety: 'danger',
      sideEffectClass: 'danger',
      inputSchema: AccountPasswordRemoveRequestV1Schema,
      outputSchema: AccountPasswordMutationResponseV1Schema,
      serverTransport: { method: 'POST', path: ACCOUNT_PASSWORD_REMOVE_PATH_V1 },
    },
    {
      id: 'account.email.change.request', executionPlacement: 'account', approval: {result: 'required'},
      title: 'Change sign-in email',
      description: 'Send verification for a replacement sign-in email address.',
      safety: 'danger',
      sideEffectClass: 'danger',
      inputSchema: AccountEmailChangeRequestV1Schema,
      outputSchema: AccountEmailChangeRequestResponseV1Schema,
      serverTransport: { method: 'POST', path: ACCOUNT_EMAIL_CHANGE_REQUEST_PATH_V1 },
    },
  ] as const).map((spec): PreNormalizedActionSpec => ({
    ...spec,
    // Enrollment, change and removal carry credential material, one-time
    // verification bearers and reauthentication proofs. That input may never
    // become durable Approval Artifact custody: a required confirmation keeps
    // the admitted present-user invocation as the waiter, and the Artifact
    // carries only the observation projection below.
    ...(spec.id === 'account.password.enroll'
      || spec.id === 'account.password.change'
      || spec.id === 'account.password.remove'
      ? { approvalInputCustody: 'live_only' as const }
      : {}),
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      // Trusted interactive CLI hosts are application-owned surfaces that prove
      // present_user, collect secrets locally, and use the canonical direct
      // confirmation host. Automated raw-input requests need an authenticated
      // decision continuation; an approval Artifact cannot confer that authority.
      cli: true,
      rpc: false,
    },
    inputHints: { title: spec.title, fields: [] },
    projectObservationInput: (input: unknown) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
      const record = input as Readonly<Record<string, unknown>>;
      return {
        ...(record.v === 1 ? { v: 1 } : {}),
        ...(record.kind === 'plain' || record.kind === 'e2ee' ? { kind: record.kind } : {}),
        ...(typeof record.expectedCredentialRevision === 'number'
          ? { expectedCredentialRevision: record.expectedCredentialRevision }
          : {}),
      };
    },
  })) satisfies readonly PreNormalizedActionSpec[]),
  {
    id: 'account.apiTokens.create', executionPlacement: 'account', approval: { flow: 'blocking', result: 'required' },
    bindings: { mcpToolName: 'account_api_tokens_create' },
    title: 'Create API token',
    description: 'Create a named API token for the current Account, optionally with trusted-device-prepared encryption access. The token secret is shown once.',
    safety: 'danger',
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: true,
      rpc: false,
    },
    sideEffectClass: 'danger',
    serverTransport: { method: 'POST', path: ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1 },
    outputSchema: AccountApiTokensCreateActionOutputV1Schema,
    projectObservationOutput: projectAccountApiTokenCreationObservation,
    // The bearer is shown once and stored only as a digest (L02 PLAN "no ...
    // compound credential reaches ... approval history"); like the Team external
    // key, it stays on the admitted invocation and never in a durable Artifact.
    approvalResultCustody: 'live_only',
    inputSchema: AccountApiTokensCreateActionInputV1Schema,
    approvalPresentation: { summary: (input: unknown) => {
      const value = AccountApiTokensCreateActionInputV1Schema.parse(input);
      return [
        value.grant === undefined ? 'Full API-eligible access.' : 'Access is defined by the reviewed grant.',
        value.expiresAt ? `Expires ${value.expiresAt}.` : 'No expiry.',
        `Encryption access: ${value.encryption ? 'yes' : 'no'}.`,
        `Unattended Team access: ${value.authorizeUnattendedTeamAccess === true ? 'yes' : 'no'}.`,
      ].join(' ');
    } },
    inputHints: {
      title: 'Create API token',
      description: 'The full token is displayed once after creation.',
      fields: [
        { path: 'tokenId', title: 'Token id', widget: 'text', required: true },
        { path: 'label', title: 'Label', widget: 'text', required: true },
        { path: 'expiresAt', title: 'Expiry', widget: 'text' },
        { path: 'grant', title: 'Access grant (omitted means full access)', widget: 'json' },
        { path: 'encryption', title: 'Encryption access (omitted means none)', widget: 'json' },
        { path: 'authorizeUnattendedTeamAccess', title: 'Authorize unattended Team access', widget: 'boolean' },
        { path: 'embedConfig', title: 'Embed configuration', widget: 'json' },
      ],
    },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'account.apiTokens.list', executionPlacement: 'account', approval: {result: 'required'},
    bindings: { mcpToolName: 'account_api_tokens_list' },
    title: 'List API tokens',
    description: 'List non-secret API-token summaries for the current Account.',
    safety: 'safe',
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: true,
      rpc: false,
      // Signed Session roots can read summaries; PAT self-management stays on
      // the dedicated bearer-only native routes.
      api: false,
    },
    sideEffectClass: 'read',
    serverTransport: { method: 'POST', path: ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1 },
    outputSchema: AccountApiTokensListActionOutputV1Schema,
    inputSchema: AccountApiTokensListActionInputV1Schema,
    inputHints: {
      title: 'List API tokens',
      description: 'Returns labels, prefixes, timestamps, and whether encryption access is present; no token secret is returned.',
      fields: [],
    },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'account.apiTokens.update', executionPlacement: 'account', approval: {result: 'required'},
    permissionChanging: true,
    bindings: { mcpToolName: 'account_api_tokens_update' },
    title: 'Update API token access',
    description: 'Update the label, grant, or embed configuration of one API token for the current Account.',
    safety: 'danger',
    placements: [],
    surfaces: { ui: true, voice: false, agent: false, mcp: false, cli: true, rpc: false },
    sideEffectClass: 'danger',
    serverTransport: { method: 'POST', path: ACCOUNT_API_TOKENS_UPDATE_HTTP_PATH_V1 },
    outputSchema: AccountApiTokensUpdateActionOutputV1Schema,
    inputSchema: AccountApiTokensUpdateActionInputV1Schema,
    inputHints: { title: 'Update API token access', fields: [
      { path: 'tokenId', title: 'Token id', widget: 'text', required: true },
      { path: 'label', title: 'Label', widget: 'text' },
      { path: 'grant', title: 'Access grant', widget: 'json' },
      { path: 'embedConfig', title: 'Embed configuration', widget: 'json' },
    ] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'account.apiTokens.revoke', executionPlacement: 'account', approval: {result: 'required'},
    confirmVerb: { key: 'files.reviewComments.durable.directWriteGrant.revoke', fallback: 'Revoke' }, irreversible: true,
    bindings: { mcpToolName: 'account_api_tokens_revoke' },
    title: 'Revoke API token',
    description: 'Revoke one API token for the current Account.',
    safety: 'danger',
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    sideEffectClass: 'danger',
    serverTransport: { method: 'POST', path: ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1 },
    outputSchema: AccountApiTokensRevokeActionOutputV1Schema,
    inputSchema: AccountApiTokensRevokeActionInputV1Schema,
    inputHints: {
      title: 'Revoke API token',
      description: 'The token stops working on the server’s next verification.',
      fields: [
        { path: 'tokenId', title: 'Token id', widget: 'text', required: true },
      ],
    },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'account.apiTokens.revokeAll', executionPlacement: 'account', approval: {result: 'required'},
    confirmVerb: { key: 'files.reviewComments.durable.directWriteGrant.revoke', fallback: 'Revoke' }, irreversible: true,
    bindings: { mcpToolName: 'account_api_tokens_revoke_all' },
    title: 'Revoke all API tokens',
    description: 'Revoke every API token for the current Account. Signed sessions are unaffected.',
    safety: 'danger',
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: false,
      mcp: false,
      cli: true,
      rpc: false,
    },
    sideEffectClass: 'danger',
    serverTransport: { method: 'POST', path: ACCOUNT_API_TOKENS_REVOKE_ALL_HTTP_PATH_V1 },
    outputSchema: AccountApiTokensRevokeAllActionOutputV1Schema,
    inputSchema: AccountApiTokensRevokeAllActionInputV1Schema,
    inputHints: {
      title: 'Revoke all API tokens',
      description: 'This permanently revokes every API token for the current Account.',
      fields: [],
    },
  } satisfies PreNormalizedActionSpec,
] as const);
}

export const ACCOUNT_SECURITY_ACTION_SPECS: ReturnType<typeof createAccountSecurityActionSpecs> = lazyActionSpecArray(createAccountSecurityActionSpecs);

