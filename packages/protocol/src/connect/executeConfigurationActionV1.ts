import { removeAgentConnectedAccountDefaultsForDeletedTarget, type AgentConnectedAccountDefaultSettings } from '../account/settings/connectedServicesSettings.js';
import type { QualifiedConnectedAccountPurposeBindingsV1 } from './connectedAccountPurposeBindings.js';
import { writeAgentDefaultChoice, type AgentDefaultChoiceAgent } from './agentDefaultChoices.js';
import { sameQualifiedConnectedAccountRef } from './qualifiedConnectedAccountPersistence.js';
import type { ConnectedMetadataCleanupV1 } from './connectedMetadataCatalogV1.js';
import type { QualifiedAcknowledgementSubject, QualifiedConnectedEntityRef, QualifiedConnectedDisclosureSubject } from './connectedAccountPresentationRowsV1.js';
import { encodeQualifiedConnectedAccountV4StructuredQueryValue } from './qualifiedConnectedAccountsV4QueryCodec.js';
import { buildQualifiedConnectedAccountGroupMutationRequestV4 } from './qualifiedConnectedAccountGroupRequestsV4.js';
import { QualifiedConnectedAccountGroupRefSchema, QualifiedConnectedAccountGroupResponseV4Schema, QualifiedConnectedAccountSuccessV4Schema, sameQualifiedConnectedAccountGroupRef, type QualifiedConnectedAccountGroupRef } from './qualifiedConnectedAccountsV4.js';
import { assertConnectedAccountOperationTransportV1, ConnectedAccountDaemonControlResponseSchema, ConnectedAccountRevokeResponseV1Schema, type ConnectedAccountDaemonControlCommand } from './connectedAccountDaemonRpcV1.js';
import {
  CONNECTED_SERVICE_CONFIGURATION_ACTION_INPUT_SCHEMAS_V1 as inputs,
  CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1 as outputs,
  reorderConnectedServicePoolMembersV1,
  type ConnectedServiceConfigurationActionIdV1,
} from './configurationActionsV1.js';
import type { ConnectedServiceQuotaGetInputV1 } from './providerAccountUsageHistory.js';
import type { ConnectedServicePoolSelectionGetRequestV1 } from './connectedServicePoolSelection.js';
import { normalizeConnectedAccountConfigurationV1, normalizeConnectedAccountConfigurationSecretValuesV1, replaceConnectedServiceConfigurationCatalogV1,
  type ConnectedServiceConfigurationCatalogHostV1 } from './connectedServiceConfigurationCatalogV1.js';
export { normalizeConnectedAccountConfigurationV1, normalizeConnectedAccountConfiguredOrigin, replaceConnectedServiceConfigurationCatalogV1 } from './connectedServiceConfigurationCatalogV1.js';
export type { ConnectedServiceConfigurationCatalogHostV1, ConnectedServiceConfigurationCatalogWriteV1 } from './connectedServiceConfigurationCatalogV1.js';

type QuotaResetInput = ReturnType<(typeof inputs)['connectedServices.quota.reset']['parse']>;
export type ConnectedAccountPurposeMutationV1 = Readonly<{
  purposeBindings: QualifiedConnectedAccountPurposeBindingsV1;
  legacySettingsDelta: Omit<NonNullable<ReturnType<typeof writeAgentDefaultChoice>>, 'connectedAccountPurposeBindingsV1'>;
}>;
export type ConnectedAccountPurposeMutationIntentV1 = (purposeBindings: QualifiedConnectedAccountPurposeBindingsV1,
  legacySettings: AgentConnectedAccountDefaultSettings) => ConnectedAccountPurposeMutationV1 | null;
export type ConnectedServiceConfigurationActionHostV1 = Readonly<{
  configurationCatalog?: ConnectedServiceConfigurationCatalogHostV1;
  /** Authenticated transport for the invocation's exact Home. */
  request(input: Readonly<{ method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; path: string; body?: unknown;
    expectedEffect?: 'qualified-connected-group-delete' }>): Promise<unknown>;
  /** One acknowledged catalog CAS, atomically retiring any changed predecessor default carriers. */
  mutatePurposeBindings(mutate: ConnectedAccountPurposeMutationIntentV1): Promise<void>;
  resolveAgent(agentId: string, machineId?: string): Promise<AgentDefaultChoiceAgent | null>;
  resetQuota(input: QuotaResetInput): Promise<unknown>;
  /** Open B only through the captured Account's canonical reader. */
  readQuota?(input: ConnectedServiceQuotaGetInputV1): Promise<unknown>;
  setSubscriptionPrice?(input: ReturnType<(typeof inputs)['connectedServices.subscription.price.set']['parse']>): Promise<void>;
  /** Read the incumbent machine selector; never change its active account. */
  readPoolSelection?(input: ConnectedServicePoolSelectionGetRequestV1): Promise<unknown>;
  controlCommand?(machineId: string, command: ConnectedAccountDaemonControlCommand): Promise<unknown>;
  /** The executing client's OS/browser boundary, never an authenticated provider mutation. */
  openBillingDestination?(url: string): Promise<void>;
  setIdentityPrivacy?: (hidden: boolean) => void;
  setConnectedLabel?(input: Readonly<{ subject: QualifiedConnectedEntityRef; label: string | null }>): Promise<void>;
  setConnectedAcknowledgement?(input: Readonly<{ subject: QualifiedAcknowledgementSubject; acknowledged: boolean | null }>): Promise<void>;
  /** Capture transfer inventory while the entity still exists; failure never blocks the primary delete. */
  prepareConnectedMetadataCleanup?(input: Readonly<{ subject: QualifiedConnectedEntityRef }>): Promise<void>;
  cleanupConnectedMetadata?(input: Readonly<{ subject: QualifiedConnectedEntityRef }>): Promise<void>;
  setConnectedDisclosure?(input: Readonly<{ subject: QualifiedConnectedDisclosureSubject; collapsed: boolean | null }>): Promise<void>;
  assertCurrent(): void;
}>;

function readGroup(value: unknown, expected: QualifiedConnectedAccountGroupRef) {
  const { group } = QualifiedConnectedAccountGroupResponseV4Schema.parse(value);
  if (!sameQualifiedConnectedAccountGroupRef(group.ref, expected)) {
    throw Object.assign(new Error('qualified_connected_accounts_inconsistent_peer'), { code: 'qualified_connected_accounts_inconsistent_peer' });
  }
  return group;
}

async function prepareMetadataCleanup(host: ConnectedServiceConfigurationActionHostV1, subject: QualifiedConnectedEntityRef): Promise<boolean> {
  if (!host.prepareConnectedMetadataCleanup) return false;
  try { await host.prepareConnectedMetadataCleanup({ subject }); return true; }
  catch { return false; }
}

async function cleanupDeletedSubject(host: ConnectedServiceConfigurationActionHostV1, subject: QualifiedConnectedEntityRef,
  prepared: boolean, mutatePurpose: ConnectedAccountPurposeMutationIntentV1): Promise<ConnectedMetadataCleanupV1> {
  let pending = !prepared || !host.cleanupConnectedMetadata;
  // Both owners get an attempt: failure in purpose cleanup must not hide an
  // independently writable presentation catalog, or erase the primary receipt.
  try { host.assertCurrent(); await host.mutatePurposeBindings(mutatePurpose); }
  catch { pending = true; }
  if (host.cleanupConnectedMetadata) {
    try { host.assertCurrent(); await host.cleanupConnectedMetadata({ subject }); }
    catch { pending = true; }
  }
  return pending ? { status: 'cleanup-pending', reason: 'connected_metadata_cleanup_pending' } : { status: 'complete' };
}

/** Read only the incumbent public profile; never invoke the revoke writer here. */
export async function prepareConnectedServiceRevokeInputV1(
  host: ConnectedServiceConfigurationActionHostV1,
  input: unknown,
) {
  host.assertCurrent();
  const args = inputs['connectedServices.accounts.revoke'].parse(input);
  if (args.emergencyRevoke || args.expectedCredentialRevision !== undefined) return args;
  if (!host.controlCommand) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' } as const;
  const admission = ConnectedAccountDaemonControlResponseSchema.parse(await host.controlCommand(args.machineId, {
    operation: 'describeService', service: args.account.service, requiredOperation: 'credential_delete',
  }));
  host.assertCurrent();
  try {
    assertConnectedAccountOperationTransportV1(admission, args.account.service, { kind: 'v4' });
  } catch {
    return { ok: false, errorCode: 'connected_account_v4_operation_unsupported', error: 'connected_account_v4_operation_unsupported' } as const;
  }
  if (admission.status !== 'described') return { ok: false, errorCode: 'connected_account_control_unavailable', error: 'connected_account_control_unavailable' } as const;
  const profile = admission.accounts.find((candidate) => sameQualifiedConnectedAccountRef(candidate.ref, args.account));
  if (!profile) return { ok: false, errorCode: 'connected_account_control_unavailable', error: 'connected_account_control_unavailable' } as const;
  if (profile.revisionSemantics !== 'revisioned') {
    return { ok: false, errorCode: 'connected_account_legacy_operation_unsupported', error: 'connected_account_legacy_operation_unsupported' } as const;
  }
  return inputs['connectedServices.accounts.revoke'].parse({ ...args, expectedCredentialRevision: profile.credentialRevision });
}

/** Thin Action adapter over the existing settings writers, pool endpoints and reset RPC. */
export async function executeConnectedServiceConfigurationActionV1(
  host: ConnectedServiceConfigurationActionHostV1,
  actionId: ConnectedServiceConfigurationActionIdV1,
  input: unknown,
): Promise<unknown> {
  host.assertCurrent();
  switch (actionId) {
    case 'connectedServices.subscription.price.set': {
      const args = inputs[actionId].parse(input);
      if (!host.setSubscriptionPrice) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      await host.setSubscriptionPrice(args);
      return { applied: true };
    }
    case 'connectedServices.configuration.get':
    case 'connectedServices.configuration.replace': {
      const args = inputs[actionId].parse(input);
      const owner = host.configurationCatalog;
      if (!owner) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      const target = { kind: 'service' as const, service: args.service, modeId: args.modeId };
      const mode = await owner.resolveMode(target);
      host.assertCurrent();
      if (!mode || mode.id !== args.modeId || !('configuration' in mode) || mode.configuration?.scope !== 'service') {
        return { ok: false, errorCode: 'connected_account_configuration_target_unavailable', error: 'connected_account_configuration_target_unavailable' };
      }
      const catalog = await owner.read();
      host.assertCurrent();
      if (catalog.status !== 'ready' || catalog.record.key !== 'configurations') {
        const code = catalog.status === 'unavailable' ? catalog.reason : 'connected_account_configuration_persistence_unavailable';
        return { ok: false, errorCode: code, error: code };
      }
      const entry = catalog.record.value.entries.find(candidate => candidate.service.pluginId === args.service.pluginId
        && candidate.service.localId === args.service.localId && candidate.modeId === args.modeId) ?? null;
      const replacement = actionId === 'connectedServices.configuration.replace'
        ? inputs['connectedServices.configuration.replace'].parse(input) : null;
      try {
        const secretValues = replacement
          ? normalizeConnectedAccountConfigurationSecretValuesV1(mode, replacement.secretValues) : {};
        const retainedSecretRefs = Object.fromEntries(Object.entries(entry?.secretRefs ?? {})
          .filter(([field]) => !Object.hasOwn(secretValues, field)));
        const normalized = await normalizeConnectedAccountConfigurationV1({ target, mode, record: entry, hasSecret: owner.hasSecret,
          ...(replacement ? { replacement: { values: replacement.values, secretRefs: retainedSecretRefs } } : {}) });
        host.assertCurrent();
        if (actionId === 'connectedServices.configuration.get') return outputs[actionId].parse({ target, mode, configuration: {
          status: normalized.revision !== null && normalized.missingFieldIds.length === 0 ? 'ready' : 'configurationRequired',
          revision: normalized.revision, values: normalized.values, configuredSecretFieldIds: Object.keys(normalized.secretRefs).sort(),
          missingFieldIds: normalized.missingFieldIds,
        } });
        if (!replacement) throw new TypeError('Configuration replacement input unavailable');
        if (normalized.missingFieldIds.some(field => !Object.hasOwn(secretValues, field))) throw Object.assign(
          new Error('connected_account_configuration_invalid'), { code: 'connected_account_configuration_invalid' });
        const write = replaceConnectedServiceConfigurationCatalogV1({ catalog, target, expectedRevision: replacement.expectedRevision,
          values: normalized.values, secretRefs: normalized.secretRefs, secretValues, createRevision: owner.createRevision });
        if (!write) return { ok: false, errorCode: 'connected_account_configuration_changed', error: 'connected_account_configuration_changed' };
        const result = await owner.write(write);
        if (result.status !== 'updated' && result.status !== 'applied') {
          const code = result.status === 'conflict' || result.status === 'settings-conflict' ? 'connected_account_configuration_changed' : result.status;
          return { ok: false, errorCode: code, error: code };
        }
        // Only the acknowledged content-free receipt survives Account retirement.
        return { applied: true, revision: write.record.value.entries.find(candidate => candidate.service.pluginId === args.service.pluginId
          && candidate.service.localId === args.service.localId && candidate.modeId === args.modeId)!.revision };
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'connected_account_configuration_invalid') {
          return { ok: false, errorCode: error.code, error: error.code };
        }
        throw error;
      }
    }
    case 'connectedServices.billing.open': {
      const args = inputs[actionId].parse(input);
      if (!host.controlCommand || !host.openBillingDestination) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      const admission = ConnectedAccountDaemonControlResponseSchema.parse(await host.controlCommand(args.machineId, {
        operation: 'describeService', service: args.account.service,
      }));
      host.assertCurrent();
      if (admission.status !== 'described' || admission.service.pluginId !== args.account.service.pluginId
        || admission.service.localId !== args.account.service.localId || admission.descriptor.id !== args.account.service.localId
        || !admission.accounts.some(profile => sameQualifiedConnectedAccountRef(profile.ref, args.account)) || !admission.descriptor.billingUrl) {
        return { ok: false, errorCode: 'connected_service_billing_unavailable', error: 'connected_service_billing_unavailable' };
      }
      await host.openBillingDestination(admission.descriptor.billingUrl);
      return outputs[actionId].parse({ opened: true });
    }
    case 'connectedServices.quota.get': {
      const args = inputs[actionId].parse(input);
      if (!host.readQuota) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      const value = await host.readQuota(args);
      host.assertCurrent();
      const result = outputs[actionId].parse(value);
      if (result.source.bindingKind !== args.source.bindingKind
          || !sameQualifiedConnectedAccountRef(result.source.ref, args.source.ref)
          || (result.source.bindingKind === 'group_member' && args.source.bindingKind === 'group_member'
            && (result.source.groupId !== args.source.groupId || result.source.groupGeneration !== args.source.groupGeneration))) {
        throw Object.assign(new Error('qualified_connected_accounts_inconsistent_peer'), { code: 'qualified_connected_accounts_inconsistent_peer' });
      }
      return result;
    }
    case 'connectedServices.pools.selection.get': {
      const args = inputs[actionId].parse(input);
      if (!host.readPoolSelection) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      const value = await host.readPoolSelection(args);
      host.assertCurrent();
      const result = outputs[actionId].parse(value);
      if ('group' in result && !sameQualifiedConnectedAccountGroupRef(result.group, args.group)) {
        throw Object.assign(new Error('qualified_connected_accounts_inconsistent_peer'), { code: 'qualified_connected_accounts_inconsistent_peer' });
      }
      return result;
    }
    case 'connectedServices.accounts.revoke': {
      const { machineId, ...command } = inputs[actionId].parse(input);
      if (!host.controlCommand) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      const subject = { kind: 'account' as const, account: command.account };
      const prepared = await prepareMetadataCleanup(host, subject);
      host.assertCurrent();
      const result = ConnectedAccountRevokeResponseV1Schema.parse(await host.controlCommand(machineId, { operation: 'revokeAccount', ...command }));
      if ('account' in result && !sameQualifiedConnectedAccountRef(result.account, command.account)) {
        return { ok: false, errorCode: 'qualified_connected_accounts_inconsistent_peer', error: 'qualified_connected_accounts_inconsistent_peer' };
      }
      if (result.status === 'revoked') {
        const metadataCleanup = await cleanupDeletedSubject(host, subject, prepared, (purposeBindings, settings) => {
          host.assertCurrent();
          const defaults = removeAgentConnectedAccountDefaultsForDeletedTarget({ settings, purposeBindings,
            target: { kind: 'account', account: command.account } });
          if (!defaults) return null;
          const { connectedAccountPurposeBindingsV1, ...legacySettingsDelta } = defaults;
          return { purposeBindings: connectedAccountPurposeBindingsV1, legacySettingsDelta };
        });
        return { ...result, metadataCleanup };
      }
      host.assertCurrent();
      return result;
    }
    case 'connectedServices.accounts.rename': {
      const { account, label } = inputs[actionId].parse(input);
      if (!host.setConnectedLabel) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      await host.setConnectedLabel({ subject: { kind: 'account', account }, label });
      // A received durable receipt is not erased by a subsequent Account switch.
      return { applied: true };
    }
    case 'connectedServices.pools.switchNow': {
      const body = inputs[actionId].parse(input);
      readGroup(await host.request({ method: 'POST', path: '/v4/connect/qualified/group/active-account', body }), body.group);
      break;
    }
    case 'connectedServices.pools.create': {
      const body = inputs[actionId].parse(input);
      const group = readGroup(await host.request(buildQualifiedConnectedAccountGroupMutationRequestV4('create', body)), { service: body.service, groupId: body.group.groupId });
      host.assertCurrent();
      return { group };
    }
    case 'connectedServices.pools.patch': {
      const body = inputs[actionId].parse(input);
      const group = readGroup(await host.request(buildQualifiedConnectedAccountGroupMutationRequestV4('patch', body)), { service: body.service, groupId: body.groupId });
      host.assertCurrent();
      return { group };
    }
    case 'connectedServices.pools.members.add':
    case 'connectedServices.pools.members.patch':
    case 'connectedServices.pools.members.remove': {
      const body = inputs[actionId].parse(input);
      const operation = actionId === 'connectedServices.pools.members.add' ? 'addMember' : actionId === 'connectedServices.pools.members.patch' ? 'patchMember' : 'removeMember';
      const group = readGroup(await host.request(buildQualifiedConnectedAccountGroupMutationRequestV4(operation, body)), body.group);
      host.assertCurrent();
      return { group };
    }
    case 'connectedServices.pools.delete': {
      const body = inputs[actionId].parse(input);
      const subject = { kind: 'group' as const, ...body.group };
      const prepared = await prepareMetadataCleanup(host, subject);
      host.assertCurrent();
      QualifiedConnectedAccountSuccessV4Schema.parse(await host.request({
        ...buildQualifiedConnectedAccountGroupMutationRequestV4('delete', body), expectedEffect: 'qualified-connected-group-delete',
      }));
      // Defaults identify a pool by ref, not incarnation. A recreated pool may
      // already own that same ref while the old DELETE acknowledgement is in flight.
      const encoded = encodeURIComponent(encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountGroupRefSchema, body.group));
      try {
        host.assertCurrent();
        readGroup(await host.request({ method: 'GET', path: `/v4/connect/qualified/group?group=${encoded}` }), body.group);
        host.assertCurrent();
        return { applied: true };
      } catch (error) {
        // Only authoritative absence permits cleanup; transport/parse/peer failures
        // must not discard a potentially useful current default.
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'connect_group_not_found') {
          return { applied: true, metadataCleanup: { status: 'cleanup-pending', reason: 'connected_metadata_cleanup_pending' } };
        }
      }
      const metadataCleanup = await cleanupDeletedSubject(host, subject, prepared, (purposeBindings, settings) => {
        host.assertCurrent();
        const cleared = removeAgentConnectedAccountDefaultsForDeletedTarget({ settings, purposeBindings, target: { kind: 'group', ...body.group } });
        if (!cleared) return null;
        const { connectedAccountPurposeBindingsV1, ...legacySettingsDelta } = cleared;
        return { purposeBindings: connectedAccountPurposeBindingsV1, legacySettingsDelta };
      });
      // This is only the acknowledged, content-free effect receipt. A retired
      // caller may not read or publish Account content, but cannot erase it.
      return { applied: true, metadataCleanup };
    }
    case 'connectedServices.pools.reorder': {
      const args = inputs[actionId].parse(input);
      const encoded = encodeURIComponent(encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountGroupRefSchema, args.group));
      const group = readGroup(await host.request({ method: 'GET', path: `/v4/connect/qualified/group?group=${encoded}` }), args.group);
      await reorderConnectedServicePoolMembersV1({ group, ...('move' in args ? { move: args.move } : { accountIds: args.accountIds }),
        members: (current) => current.members.map((member) => ({ accountId: member.connectedAccountId, priority: member.priority })),
        patch: async (current, connectedAccountId, priority) => {
          host.assertCurrent();
          const request = buildQualifiedConnectedAccountGroupMutationRequestV4('patchMember', { group: current.ref, connectedAccountId, priority,
            expectedGeneration: current.generation, expectedIncarnation: current.incarnation, expectedRuntimeStateRevision: current.runtimeStateRevision });
          return readGroup(await host.request(request), args.group);
        },
      });
      break;
    }
    case 'connectedServices.accounts.default.set':
    case 'connectedServices.pools.default.set': {
      const args = inputs[actionId].parse(input);
      const agent = await host.resolveAgent(args.agentId, args.machineId);
      host.assertCurrent();
      if (!agent) return { ok: false, errorCode: 'unknown_agent', error: 'unknown_agent' };
      await host.mutatePurposeBindings((purposeBindings, settings) => {
        host.assertCurrent();
        const written = writeAgentDefaultChoice({ agents: [agent], agentId: args.agentId, makeDefault: args.makeDefault,
          settings, purposeBindings, target: 'account' in args ? { kind: 'account', account: args.account } : { kind: 'group', ...args.group } });
        if (!written) throw Object.assign(new Error('agent_connected_service_unavailable'), { code: 'agent_connected_service_unavailable' });
        const { connectedAccountPurposeBindingsV1, ...legacySettingsDelta } = written;
        return { purposeBindings: connectedAccountPurposeBindingsV1, legacySettingsDelta };
      });
      // Only this content-free acknowledgement survives caller retirement.
      // Private reads and group-response projections retain their currentness checks.
      return { applied: true };
    }
    case 'connectedServices.quota.reset':
      return await host.resetQuota(inputs[actionId].parse(input));
    case 'connectedServices.quota.refresh': {
      const { account, machineId } = inputs[actionId].parse(input);
      if (!host.controlCommand) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      const admission = ConnectedAccountDaemonControlResponseSchema.parse(await host.controlCommand(machineId, {
        operation: 'describeService', service: account.service, requiredOperation: 'quota_refresh',
      }));
      host.assertCurrent();
      try {
        assertConnectedAccountOperationTransportV1(admission, account.service, { kind: 'v4' });
      } catch (error) {
        if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
          return { ok: false, errorCode: error.code, error: error.message };
        }
        throw error;
      }
      QualifiedConnectedAccountSuccessV4Schema.parse(await host.request({ method: 'POST', path: '/v4/connect/qualified/quotas/refresh', body: { ref: account } }));
      break;
    }
    case 'connectedServices.identityPrivacy.set': {
      if (!host.setIdentityPrivacy) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      host.setIdentityPrivacy(inputs[actionId].parse(input).hidden);
      break;
    }
    case 'connectedServices.acknowledgements.set': {
      if (!host.setConnectedAcknowledgement) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      const args = inputs[actionId].parse(input);
      await host.setConnectedAcknowledgement(args);
      return { applied: true };
    }
    case 'connectedServices.acknowledgements.reset': {
      if (!host.setConnectedAcknowledgement) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      await host.setConnectedAcknowledgement({ subject: inputs[actionId].parse(input).subject, acknowledged: null });
      return { applied: true };
    }
    case 'connectedServices.labels.set': {
      if (!host.setConnectedLabel) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      const args = inputs[actionId].parse(input);
      await host.setConnectedLabel(args);
      return { applied: true };
    }
    case 'connectedServices.labels.reset': {
      if (!host.setConnectedLabel) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      await host.setConnectedLabel({ subject: inputs[actionId].parse(input).subject, label: null });
      return { applied: true };
    }
    case 'connectedServices.disclosure.set': {
      if (!host.setConnectedDisclosure) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      const args = inputs[actionId].parse(input);
      await host.setConnectedDisclosure(args);
      return { applied: true };
    }
    case 'connectedServices.disclosure.reset': {
      if (!host.setConnectedDisclosure) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      await host.setConnectedDisclosure({ subject: inputs[actionId].parse(input).subject, collapsed: null });
      return { applied: true };
    }
  }
  host.assertCurrent();
  return { applied: true };
}
