import { randomBytes as nodeRandomBytes } from 'node:crypto';

import axios from 'axios';

import { AutomationConversationActionHttpPathsV1, AutomationConversationActionHttpRequestSchemasV1, AutomationConversationAdmitEncryptedHttpRequestV1Schema } from '@happier-dev/protocol/automations/event';
import { AutomationConversationActionInputSchemasV1, AutomationConversationActionOutputSchemasV1 } from '@happier-dev/protocol/automations/automationActionSpecsV1';
import { AutomationConversationAdmitInputV1Schema, isAutomationConversationAdmitScopedCorrespondenceV1 } from '@happier-dev/protocol/automations/result-delivery';
import { PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1 } from '@happier-dev/protocol/plugins/installations/manifests';
import { PluginMachineMaterializationRefV1Schema } from '@happier-dev/protocol/plugins/availability/materializationRefV1';
import { buildAutomationConversationOccurrenceEvidenceV1, deriveAutomationOccurrenceKeyV1 } from '@happier-dev/protocol/automations/automationOccurrenceV1';
import { deriveAutomationOccurrenceTriggerEvidenceEqualityTagV1, sealAutomationOccurrenceTriggerEvidenceEnvelopeV1, sealAutomationRunTriggerEvidenceEnvelopeV1 } from '@happier-dev/protocol/automations/automationEventTriggerEvidence';
import { sealAutomationConversationReplyContextStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationReplyHandoffStoredContent';
import type { AccountEncryptionCurrentnessResponse, AccountScopedCryptoMaterialSnapshotV1, ActionExecutorDeps, AutomationConversationActionHttpRequestByIdV1, AutomationConversationActionIdV1, PluginMachineMaterializationRefV1 } from '@happier-dev/protocol';

import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { fetchChangesAccountId } from '@/api/changes';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { configuration } from '@/configuration';
import { createDefaultPluginInstallationPublisherHeader } from '@/plugins/installations/publisherProof';
import {
  createPluginActionCallerCurrentnessCheck,
  type RevalidatePluginActionCallerOccurrence,
  type RevalidatePluginActionCallerMaterialization,
} from '@/plugins/runtime/invocation/services/actionCaller';
import {
  createAutomationAccountEncryptionMaterialSnapshotV1,
  isAvailableE2eeAutomationAccountEncryptionV1,
  resolveValidatedAutomationAccountEncryptionV1,
  type AvailableAutomationAccountEncryptionV1,
} from '@/plugins/runtime/automations/automationAccountCurrentness';
import type { StoredCredentials } from '@/persistence';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';

type ExecuteAutomationConversationAction = NonNullable<ActionExecutorDeps['automationConversationAction']>;

type AutomationConversationActionCallerFrame = Readonly<{
  pluginId: string;
  contributionLocalId: string;
  occurrenceId: string;
  sourceCustody: import('@happier-dev/protocol').PluginSourceCustodyV1;
  materialization: PluginMachineMaterializationRefV1;
}>;

export type AutomationConversationActionTransport = Readonly<{
  execute<TActionId extends AutomationConversationActionIdV1>(
    actionId: TActionId,
    request: AutomationConversationActionHttpRequestByIdV1[TActionId],
    signal?: AbortSignal,
  ): Promise<unknown>;
}>;

function failure(errorCode: string): Readonly<{ ok: false; errorCode: string; error: string }> {
  return { ok: false, errorCode, error: errorCode };
}

function createEmptySignal(): AbortSignal {
  return new AbortController().signal;
}

function createDefaultTransport(credentials: StoredCredentials): AutomationConversationActionTransport {
  return Object.freeze({
    async execute(actionId, request, signal) {
      signal?.throwIfAborted();
      const path = AutomationConversationActionHttpPathsV1[actionId];
      const body = AutomationConversationActionHttpRequestSchemasV1[actionId].parse(request);
      const publisherHeader = await createDefaultPluginInstallationPublisherHeader({
        method: 'POST',
        path,
        body,
      });
      if (!publisherHeader) {
        return failure('automation_conversation_publisher_proof_unavailable');
      }
      signal?.throwIfAborted();
      const response = await axios.post(`${resolveServerHttpBaseUrl()}${path}`, body, {
        headers: {
          ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
          Authorization: `Bearer ${credentials.token}`,
          [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: publisherHeader,
        },
        timeout: configuration.sessionControlHttpTimeoutMs,
        validateStatus: (status) => status >= 200 && status < 300,
        ...(signal ? { signal } : {}),
      });
      return AutomationConversationActionOutputSchemasV1[actionId].parse(response.data);
    },
  });
}

/**
 * CLI binding for the Automation conversation Action. The host stamps its
 * current plugin contribution and materialization; the payload cannot
 * select the delivery target or impersonate that caller frame.
 *
 * It is also the authenticated admission host for Account content: a plain
 * Account sends the semantic Action input, while an E2EE Account has its
 * occurrence evidence sealed and its rejoin tag derived here, so the server
 * receives no sender, message text, or reply context.
 */
export function createAutomationConversationActionExecutor(params: Readonly<{
  credentials: StoredCredentials;
  transport?: AutomationConversationActionTransport;
  revalidateCallerMaterialization?: RevalidatePluginActionCallerMaterialization;
  /** Rechecks the exact host-stamped admitted bytes; it never substitutes one. */
  revalidateCallerOccurrence?: RevalidatePluginActionCallerOccurrence;
  resolveAccountId?: (signal?: AbortSignal) => Promise<string>;
  resolveAccountEncryptionCurrentness?: (
    signal?: AbortSignal,
  ) => Promise<AccountEncryptionCurrentnessResponse>;
  resolveAccountEncryptionMaterial?: (
    signal?: AbortSignal,
  ) => Promise<AccountScopedCryptoMaterialSnapshotV1 | null>;
  randomBytes?: (length: number) => Uint8Array;
}>): ExecuteAutomationConversationAction {
  const transport = params.transport ?? createDefaultTransport(params.credentials);
  const revalidateCallerMaterialization = params.revalidateCallerMaterialization;
  const revalidateCallerOccurrence = params.revalidateCallerOccurrence;
  const resolveAccountId = params.resolveAccountId
    ?? (async (signal?: AbortSignal) => await fetchChangesAccountId({
      token: params.credentials.token,
      ...(signal ? { signal } : {}),
    }));
  const resolveAccountEncryptionCurrentness = params.resolveAccountEncryptionCurrentness
    ?? (async (signal?: AbortSignal) => await fetchAccountEncryptionCurrentness({
      token: params.credentials.token,
      ...(signal ? { signal } : {}),
    }));
  const resolveAccountEncryptionMaterial = params.resolveAccountEncryptionMaterial
    ?? (async (_signal?: AbortSignal) =>
      createAutomationAccountEncryptionMaterialSnapshotV1(params.credentials));
  const randomBytes = params.randomBytes ?? nodeRandomBytes;
  // One Account crypto/currentness owner for this host's admission boundary.
  const resolveAccountEncryption = async (
    signal?: AbortSignal,
  ): Promise<AvailableAutomationAccountEncryptionV1 | null> => {
    const accountEncryption = await resolveValidatedAutomationAccountEncryptionV1({
      signal: signal ?? createEmptySignal(),
      resolveAccountEncryptionCurrentness,
      resolveAccountEncryptionMaterial,
    });
    return accountEncryption.kind === 'available' ? accountEncryption : null;
  };

  return async (args) => {
    const contributionLocalId = args.caller.contributionLocalId;
    if (typeof contributionLocalId !== 'string' || contributionLocalId.trim().length === 0) {
      return failure('automation_conversation_caller_contribution_unavailable');
    }
    const materialization = PluginMachineMaterializationRefV1Schema.safeParse(
      args.caller.materialization,
    );
    if (!materialization.success || materialization.data.pluginId !== args.caller.pluginId) {
      return failure('automation_conversation_caller_materialization_unavailable');
    }
    const occurrenceId = args.caller.occurrenceId;
    const sourceCustody = args.caller.sourceCustody;
    if (occurrenceId === undefined || sourceCustody === undefined || !revalidateCallerOccurrence) {
      return failure('automation_conversation_caller_occurrence_unavailable');
    }
    if (!revalidateCallerMaterialization) {
      return failure('automation_conversation_caller_materialization_unavailable');
    }
    const caller: AutomationConversationActionCallerFrame = {
      pluginId: args.caller.pluginId,
      contributionLocalId,
      occurrenceId,
      sourceCustody,
      materialization: materialization.data,
    };
    const revalidateCaller = createPluginActionCallerCurrentnessCheck({
      caller: {
        pluginId: args.caller.pluginId,
        occurrenceId,
        materialization: materialization.data,
      },
      revalidateMaterialization: revalidateCallerMaterialization,
      revalidateOccurrence: revalidateCallerOccurrence,
    });
    const callerNoLongerCurrent = async (): Promise<
      Readonly<{ ok: false; errorCode: string; error: string }> | null
    > => {
      const currentness = await revalidateCaller();
      if (currentness.kind === 'current') return null;
      return failure(currentness.kind === 'occurrenceUnavailable'
        ? 'automation_conversation_caller_occurrence_unavailable'
        : 'automation_conversation_caller_materialization_unavailable');
    };

    if (args.actionId === 'automation.conversation.targets.list') {
      const staleCaller = await callerNoLongerCurrent();
      if (staleCaller) return staleCaller;
      return await transport.execute(args.actionId, {
        v: 1,
        caller,
        input: AutomationConversationActionInputSchemasV1[args.actionId].parse(args.input),
      }, args.signal);
    }
    if (args.actionId === 'automation.conversation.target.verify') {
      const input = AutomationConversationActionInputSchemasV1[args.actionId].parse(args.input);
      const scopedTrigger = input.scopedTrigger === undefined ? undefined : (() => {
        const { pullRequest: _privateSelection, ...correspondence } = input.scopedTrigger;
        return correspondence;
      })();
      const staleCaller = await callerNoLongerCurrent();
      if (staleCaller) return staleCaller;
      return await transport.execute(args.actionId, {
        v: 1,
        caller,
        input: { ...input, ...(scopedTrigger === undefined ? {} : { scopedTrigger }) },
      }, args.signal);
    }

    const input = AutomationConversationAdmitInputV1Schema.parse(args.input);
    // The server cannot open a sealed occurrence's sender or binding. Prove
    // the same semantic correspondence in either Account mode before sealing.
    if (!isAutomationConversationAdmitScopedCorrespondenceV1(input)) {
      return { kind: 'refused', reason: 'scopedTriggerIdentityMismatch', checkpointSafe: true };
    }
    // Admission is the durable effect boundary. Account currentness, identity,
    // crypto materialization, evidence construction and sealing can all await,
    // and the outer dispatcher rechecks the caller only after this host Action
    // returns — already past the server write. The exact stamped caller is
    // therefore reproven immediately before every admission request. The read
    // operations above use the same exact-generation check at their own HTTP
    // boundary rather than relying on a later outer-dispatcher check.
    const accountEncryption = await resolveAccountEncryption(args.signal);
    if (accountEncryption === null) {
      return failure('automation_conversation_account_encryption_unavailable');
    }
    if (!isAvailableE2eeAutomationAccountEncryptionV1(accountEncryption)) {
      const plainReplyHandoff = input.resultDelivery.kind === 'none'
        ? undefined
        : (() => {
          const occurrenceKey = deriveAutomationOccurrenceKeyV1(
            buildAutomationConversationOccurrenceEvidenceV1({
              accountMode: 'plain',
              bindingId: input.bindingId,
              occurrenceId: input.occurrenceId,
              occurredAt: input.occurredAt,
              caller: {
                pluginId: caller.pluginId,
                contributionLocalId: caller.contributionLocalId,
                machineId: caller.materialization.machineId,
              },
              sender: input.sender,
              text: input.text,
              resultDelivery: input.resultDelivery,
              hostEvidence: input.hostEvidence,
            }),
          );
          return {
            actionRef: input.resultDelivery.actionRef,
            replyContextEnvelope: sealAutomationConversationReplyContextStoredEnvelopeV1({
              mode: 'plain',
              correspondence: { automationId: input.automationId, occurrenceKey },
              opaqueContext: input.resultDelivery.opaqueContext,
            }),
          };
        })();
      const staleCaller = await callerNoLongerCurrent();
      if (staleCaller) return staleCaller;
      return await transport.execute(
        'automation.conversation.admit',
        {
          v: 1,
          caller,
          input,
          ...(plainReplyHandoff === undefined ? {} : { replyHandoff: plainReplyHandoff }),
        },
        args.signal,
      );
    }

    const accountId = await resolveAccountId(args.signal);
    const material = accountEncryption.material.material;
    const evidence = buildAutomationConversationOccurrenceEvidenceV1({
      accountMode: 'e2ee',
      bindingId: input.bindingId,
      occurrenceId: input.occurrenceId,
      occurredAt: input.occurredAt,
      caller: {
        pluginId: caller.pluginId,
        contributionLocalId: caller.contributionLocalId,
        machineId: caller.materialization.machineId,
      },
      sender: input.sender,
      text: input.text,
      resultDelivery: input.resultDelivery,
      hostEvidence: input.hostEvidence,
    });
    const occurrenceKey = deriveAutomationOccurrenceKeyV1(evidence);
    const replyHandoff = input.resultDelivery.kind === 'none'
      ? undefined
      : {
        actionRef: input.resultDelivery.actionRef,
        replyContextEnvelope: sealAutomationConversationReplyContextStoredEnvelopeV1({
          mode: 'e2ee',
          material,
          randomBytes,
          correspondence: { automationId: input.automationId, occurrenceKey },
          opaqueContext: input.resultDelivery.opaqueContext,
        }),
      };
    const scopedTrigger = input.hostEvidence === undefined ? undefined : (() => {
      const { pullRequest: _privateSelection, ...correspondence } = input.hostEvidence;
      return correspondence;
    })();
    const request = AutomationConversationAdmitEncryptedHttpRequestV1Schema.parse({
      v: 1,
      caller,
      hostEvidence: {
        v: 1,
        t: 'encrypted',
        accountCurrentness: accountEncryption.witness,
        automationId: input.automationId,
        occurrenceKey,
        occurredAt: input.occurredAt,
        ...(scopedTrigger === undefined ? {} : { scopedTrigger }),
        triggerEvidenceEnvelope: sealAutomationOccurrenceTriggerEvidenceEnvelopeV1({
          material,
          evidence,
          randomBytes,
        }),
        executionTriggerEvidenceEnvelope: sealAutomationRunTriggerEvidenceEnvelopeV1({
          material,
          randomBytes,
          evidence: {
            ...evidence,
            observationReceivedAt: Date.now(),
          },
        }),
        occurrenceEvidenceEqualityTag: deriveAutomationOccurrenceTriggerEvidenceEqualityTagV1({
          material,
          accountId,
          automationId: input.automationId,
          evidence,
        }),
        ...(replyHandoff === undefined ? {} : { replyHandoff }),
      },
    });
    const staleCaller = await callerNoLongerCurrent();
    if (staleCaller) return staleCaller;
    return await transport.execute('automation.conversation.admit', request, args.signal);
  };
}
