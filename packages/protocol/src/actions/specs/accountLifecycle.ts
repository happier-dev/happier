import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { ACCOUNT_LIFECYCLE_ACTION_INPUT_SCHEMAS as inputs, ACCOUNT_LIFECYCLE_ACTION_OUTPUT_SCHEMAS as outputs } from '../accountLifecycleActionFamily.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import type { AccountLifecycleActionId } from '../accountLifecycleActionFamily.js';

export type AccountLifecycleActionSpec = {
  [Id in AccountLifecycleActionId]: PreNormalizedActionSpec & {
    id: Id;
    inputSchema: (typeof inputs)[Id];
    outputSchema: (typeof outputs)[Id];
    requiredAuthority: 'account_automation';
  };
}[AccountLifecycleActionId];

const cli = { acceptsServerId: true, commands: [] } satisfies NonNullable<PreNormalizedActionSpec['cli']>;
const common = {
  placements: [], executionPlacement: 'client', requiredAuthority: 'account_automation',
  surfaces: { ui: true, agent: true, mcp: true, voice: false, cli: true, rpc: false },
  cli,
  inputHints: { fields: [
    { path: 'serverId', title: 'Invoking Home', widget: 'text', required: true },
    { path: 'accountId', title: 'Your Account', widget: 'text', required: true },
  ] },
} as const;
export const ACCOUNT_LIFECYCLE_ACTION_SPECS: readonly AccountLifecycleActionSpec[] = lazyActionSpecArray(() => [
  { ...common, id: 'account.signOut', approval: {result: 'required'}, title: 'Sign out of this Home',
    accountAuthorityRetirementStatuses: ['signed_out'],
    description: 'Forget this Account’s sign-in on this device. Other Homes and the sign-in service remain signed in.',
    safety: 'safe', sideEffectClass: 'write', bindings: { mcpToolName: 'account_sign_out' },
    inputSchema: inputs['account.signOut'], outputSchema: outputs['account.signOut'] },
  { ...common, id: 'account.credentials.forgetAll', approval: {result: 'required'}, title: 'Forget all credentials on this device',
    irreversible: true,
    accountAuthorityRetirementStatuses: ['forgotten'],
    description: 'Forget every Home and sign-in-service credential stored on this device.',
    safety: 'danger', sideEffectClass: 'danger', bindings: { mcpToolName: 'account_credentials_forget_all' },
    inputHints: { fields: [...common.inputHints.fields,
      { path: 'scope', title: 'All credentials on this device', widget: 'text', required: true }] },
    inputSchema: inputs['account.credentials.forgetAll'], outputSchema: outputs['account.credentials.forgetAll'] },
  { ...common, id: 'account.delete', approval: {result: 'required'}, approvalPolicy: { uiConfirmation: 'policy' }, title: 'Delete your Account on this Home',
    confirmVerb: { key: 'common.delete', fallback: 'Delete' }, irreversible: true,
    accountAuthorityRetirementStatuses: ['deleted', 'deleted_cleanup_pending', 'disabled_pending_completion'],
    description: 'Permanently erase your Account on this Home, reviewing retained resources before removing its local credentials.',
    safety: 'danger', sideEffectClass: 'danger', bindings: { mcpToolName: 'account_delete' },
    inputSchema: inputs['account.delete'], outputSchema: outputs['account.delete'] },
] as const satisfies readonly PreNormalizedActionSpec[]);
