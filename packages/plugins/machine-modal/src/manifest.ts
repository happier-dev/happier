import { definePlugin } from '@happier-dev/plugin-sdk';
import { machinePresentationLabel, machineCheckPresentation } from './ui/translations.js';
import type { ActionContribution } from '@happier-dev/plugin-sdk/actions';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import {
  MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerCheckResultV1Schema,
  MachineProvisionerNativeExecResultV1Schema, MachineProvisionerObservationV1Schema,
  MachineProvisionerOptionsResultV1Schema, MachineProvisionerPowerResultV1Schema, MachineProvisionerPutFileResultV1Schema,
} from '@happier-dev/plugin-sdk/machine-provisioners';
import type { MachineProvisionerAuthorDefinitionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { MODAL_ACCOUNT_ID, MODAL_ACCOUNT_PURPOSE, MODAL_CONNECTED_ACCOUNT_RUNTIME } from './machine/connectedAccount.js';
import { MODAL_BILLING, MODAL_PLUGIN_ID, MODAL_PROVISIONER_ID } from './machine/roles.js';
import { MODAL_ROLE_SCHEMAS, MODAL_RECONCILIATION_SCHEMAS, ModalOptionsInputV1Schema, ModalNativeOperationV1Schema, ModalLaunchV1Schema, ModalResourceV1Schema } from './machine/schemas.js';
import { invokeScopedModalRole } from './machine/scopedSdk.js';
import { MODAL_CONFIGURATION_LABELS, MODAL_UI_TRANSLATION_BUNDLES } from './ui/translations.js';

const networkAccess = 'modal-network';
const defaults = { scopes: ['machine'], surfaces: ['cli', 'plugin'], hostAccess: [MODAL_ACCOUNT_PURPOSE, networkAccess] } as const;
const effectConfirmation = { confirmation: { title: 'Approve this Modal operation?',
  body: 'Operate the reviewed Sandbox using its selected credential and native lifetime.', confirmLabel: 'Continue' } } as const;
const destroyConfirmation = { confirmation: { title: 'End this Modal Sandbox?',
  body: 'Terminate this exact Sandbox. Its running compute and filesystem will be lost.', confirmLabel: 'End Sandbox' } } as const;
function code(error: unknown) {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'modal_unavailable';
}
function configurationLabel(id: keyof typeof MODAL_CONFIGURATION_LABELS.en) {
  return { key: `machineModal.configure.${id}`, fallback: MODAL_CONFIGURATION_LABELS.en[id] };
}

export const MODAL_MACHINE_PROVISIONER = {
  title: 'Modal', icon: 'cloud', resourceKind: 'modal-sandbox', schemaVersion: 1,
  kindTitle: machinePresentationLabel('kind'), description: machinePresentationLabel('description'),
  launchSchema: ModalLaunchV1Schema.jsonSchema, resourceSchema: ModalResourceV1Schema.jsonSchema,
  platforms: ['darwin', 'linux', 'win32'], prerequisites: [],
  billing: MODAL_BILLING, retention: { supportedIntents: ['delete'], finiteOnly: true },
  actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy' },
  nativeDurationInput: { path: 'timeoutMs', unit: 'milliseconds' },
  bootstrapTransport: { kind: 'native', exec: 'exec', putFile: 'put-file' },
  reconciliation: { nativeOperationSchema: ModalNativeOperationV1Schema.jsonSchema, action: 'reconcile' },
} satisfies MachineProvisionerAuthorDefinitionV1;

export const MODAL_PLUGIN = definePlugin({
  id: MODAL_PLUGIN_ID, version: '0.0.0', displayName: 'Modal Machines',
  description: 'Finite Modal Sandboxes with private native bootstrap IO.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: { required: [{ id: MODAL_ACCOUNT_PURPOSE, capability: 'connectedAccounts',
    reason: 'Use the exact reviewed Modal token and profile.',
    scope: { serviceRefs: [MODAL_ACCOUNT_ID], operations: ['select', 'use'], materializationKinds: ['environment'] },
  }, { id: networkAccess, capability: 'network', reason: 'Operate the exact reviewed Modal Sandbox through its native SDK.',
    scope: { targets: [{ kind: 'connectedAccountOrigin', service: MODAL_ACCOUNT_ID }, { kind: 'httpsHostSuffix', hostSuffix: 'modal.com' },
      { kind: 'httpsHostSuffix', hostSuffix: 'modal.run' }] },
  }], optional: [] },
  connectedAccountDescriptors: { [MODAL_ACCOUNT_ID]: {
    declaration: { title: 'Modal', authentication: { defaultModeId: 'token', modes: [{ id: 'token', kind: 'manual',
      outcomeReconciliation: 'none', directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
      fields: [{ id: 'tokenId', title: 'Token ID', schema: { type: 'string', minLength: 1 }, secret: true },
        { id: 'tokenSecret', title: 'Token secret', schema: { type: 'string', minLength: 1 }, secret: true }],
      configuration: { scope: 'account', changeBehavior: 'reconnect', fields: [{ id: 'serverUrl', title: 'Modal API origin', semantic: 'connectedAccountOrigin',
        schema: { type: 'string', minLength: 1 }, required: true, secret: false },
      { id: 'environment', title: 'Modal environment', schema: { type: 'string' }, required: false, secret: false }] },
    }] } }, runtime: MODAL_CONNECTED_ACCOUNT_RUNTIME,
  } },
  machineProvisioners: { [MODAL_PROVISIONER_ID]: MODAL_MACHINE_PROVISIONER },
  actions: {
    check: { ...defaults, title: 'Check Modal availability', dangerLevel: 'safe', inputSchema: MODAL_ROLE_SCHEMAS.checkInput,
      resultSchema: MachineProvisionerCheckResultV1Schema, async run(input, context) {
        try { return machineCheckPresentation(MachineProvisionerCheckResultV1Schema.parse(await invokeScopedModalRole('check', input, context))); }
        catch (error) { return machineCheckPresentation({ available: false, code: code(error) }); }
      } },
    options: { ...defaults, title: 'Read Modal choices', dangerLevel: 'safe', inputSchema: ModalOptionsInputV1Schema,
      inputHints: { fields: [
        { path: 'appReference', title: configurationLabel('appReference'), widget: 'text', required: true },
        { path: 'imageReference', title: configurationLabel('imageReference'), widget: 'text', required: true },
        { path: 'resources.cpu', title: configurationLabel('cpu'), widget: 'number', required: true },
        { path: 'resources.memoryMb', title: configurationLabel('memoryMb'), widget: 'integer', required: true },
        { path: 'timeoutMs', title: configurationLabel('timeoutMs'), widget: 'integer', required: true,
          description: configurationLabel('timeoutDescription') },
      ] } satisfies NonNullable<ActionContribution['inputHints']>,
      resultSchema: MachineProvisionerOptionsResultV1Schema, async run(input, context) {
        return MachineProvisionerOptionsResultV1Schema.parse(await invokeScopedModalRole('options', input, context));
      } },
    acquire: { ...defaults, ...effectConfirmation, title: 'Acquire finite Modal Sandbox', dangerLevel: 'writesRemote', inputSchema: MODAL_ROLE_SCHEMAS.acquireInput,
      resultSchema: MODAL_RECONCILIATION_SCHEMAS.result, async run(input, context) {
        try { return MODAL_RECONCILIATION_SCHEMAS.result.parse(await invokeScopedModalRole('acquire', input, context)); }
        catch (error) { const reason = code(error);
          return reason === 'credential_unavailable' ? { kind: 'rejected' as const, code: 'credential_unavailable' as const }
            : input.managedId ? { kind: 'pending' as const, nativeOperationRef: {
              contributionRef: { pluginId: MODAL_PLUGIN_ID, localId: MODAL_PROVISIONER_ID }, schemaVersion: 1,
              value: { appReference: input.launch.appReference, managedId: input.managedId },
            } } : { kind: 'unknown' as const, recovery: { reference: input.launch.appReference, reason } };
        }
      } },
    reconcile: { ...defaults, title: 'Recover retained Modal Sandbox', dangerLevel: 'safe',
      inputSchema: MODAL_RECONCILIATION_SCHEMAS.input, resultSchema: MODAL_RECONCILIATION_SCHEMAS.result,
      async run(input, context) { return MODAL_RECONCILIATION_SCHEMAS.result.parse(await invokeScopedModalRole('reconcile', input, context)); } },
    bootstrap: { ...defaults, ...effectConfirmation, title: 'Resolve private Modal bootstrap transport', dangerLevel: 'writesRemote', inputSchema: MODAL_ROLE_SCHEMAS.bootstrapInput,
      resultSchema: MachineProvisionerBootstrapCarrierV1Schema, async run(input, context) {
        return MachineProvisionerBootstrapCarrierV1Schema.parse(await invokeScopedModalRole('bootstrap', input, context));
      } },
    inspect: { ...defaults, title: 'Inspect retained Modal Sandbox', dangerLevel: 'safe', inputSchema: MODAL_ROLE_SCHEMAS.resourceInput,
      resultSchema: MachineProvisionerObservationV1Schema, async run(input, context) {
        try { return MachineProvisionerObservationV1Schema.parse(await invokeScopedModalRole('inspect', input, context)); }
        catch (error) { return { observedAt: context.invokedAtMs, availability: 'unavailable' as const, reason: code(error) }; }
      } },
    destroy: { ...defaults, ...destroyConfirmation, title: 'Terminate exact Modal Sandbox', dangerLevel: 'destructive', inputSchema: MODAL_RECONCILIATION_SCHEMAS.destroyInput,
      resultSchema: MachineProvisionerPowerResultV1Schema, async run(input, context) {
        try { return MachineProvisionerPowerResultV1Schema.parse(await invokeScopedModalRole('destroy', input, context)); }
        catch (error) { return { kind: 'unknown' as const, code: code(error) }; }
      } },
    exec: { ...defaults, ...effectConfirmation, title: 'Execute private Modal bootstrap IO', dangerLevel: 'writesRemote', inputSchema: MODAL_ROLE_SCHEMAS.execInput,
      resultSchema: MachineProvisionerNativeExecResultV1Schema, async run(input, context) {
        return MachineProvisionerNativeExecResultV1Schema.parse(await invokeScopedModalRole('exec', input, context));
      } },
    'put-file': { ...defaults, ...effectConfirmation, title: 'Write private Modal bootstrap file', dangerLevel: 'writesRemote', inputSchema: MODAL_ROLE_SCHEMAS.putFileInput,
      resultSchema: MachineProvisionerPutFileResultV1Schema, async run(input, context) {
        try { return MachineProvisionerPutFileResultV1Schema.parse(await invokeScopedModalRole('putFile', input, context)); }
        catch (error) { return { kind: 'unknown' as const, code: code(error) }; }
      } },
  },
  ui: { translations: MODAL_UI_TRANSLATION_BUNDLES },
});

export const PLUGIN_MANIFEST = MODAL_PLUGIN.manifest;
