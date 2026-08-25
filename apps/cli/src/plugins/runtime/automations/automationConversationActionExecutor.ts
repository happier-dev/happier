import { randomBytes as nodeRandomBytes } from 'node:crypto';

import axios from 'axios';

import {
  AutomationConversationActionHttpPathsV1,
  AutomationConversationActionHttpRequestSchemasV1,
  AutomationConversationActionInputSchemasV1,
  AutomationConversationActionOutputSchemasV1,
  AutomationConversationAdmitEncryptedHttpRequestV1Schema,
  AutomationConversationAdmitInputV1Schema,
  PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
  PluginMachineMaterializationRefV1Schema,
  buildAutomationConversationOccurrenceEvidenceV1,
  deriveAutomationOccurrenceKeyV1,
  deriveAutomationOccurrenceTriggerEvidenceEqualityTagV1,
  sealAutomationConversationReplyContextStoredEnvelopeV1,
  sealAutomationOccurrenceTriggerEvidenceEnvelopeV1,
  sealAutomationRunTriggerEvidenceEnvelopeV1,
  type AccountEncryptionCurrentnessResponse,
  type AccountScopedCryptoMaterialSnapshotV1,
  type ActionExecutorDeps,
  type AutomationConversationActionHttpRequestByIdV1,
  type AutomationConversationActionIdV1,
  type PluginMachineMaterializationRefV1,
} from '@happier-dev/protocol';

import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { fetchChangesAccountId } from '@/api/changes';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { configuration } from '@/configuration';
import { createDefaultPluginInstallationPublisherHeader } from '@/plugins/installations/publisherProof';
import {
  createPluginActionCallerCurrentnessCheck,
  type RevalidatePluginActionCallerImmutableGeneration,
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
  revalidateCallerImmutableGeneration?: RevalidatePluginActionCallerImmutableGeneration;
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
  const revalidateCallerImmutableGeneration = params.revalidateCallerImmutableGeneration;
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
    const caller: AutomationConversationActionCallerFrame = {
      pluginId: args.caller.pluginId,
      contributionLocalId,
      materialization: materialization.data,
    };

    if (args.actionId === 'automation.conversation.targets.list') {
      return await transport.execute(args.actionId, {
        v: 1,
        caller,
        input: AutomationConversationActionInputSchemasV1[args.actionId].parse(args.input),
      }, args.signal);
    }
    if (args.actionId === 'automation.conversation.target.verify') {
      return await transport.execute(args.actionId, {
        v: 1,
        caller,
        input: AutomationConversationActionInputSchemasV1[args.actionId].parse(args.input),
      }, args.signal);
    }

    const input = AutomationConversationAdmitInputV1Schema.parse(args.input);
    // Admission is the durable effect boundary. Account currentness, identity,
    // crypto materialization, evidence construction and sealing can all await,
    // and the outer dispatcher rechecks the caller only after this host Action
    // returns — already past the server write. The exact stamped caller is
    // therefore reproven immediately before every admission request. The reads
    // above are not durable and do not acquire this write-effect fence.
    const revalidateCaller = revalidateCallerMaterialization
      ? createPluginActionCallerCurrentnessCheck({
        caller: {
          pluginId: args.caller.pluginId,
          ...(args.caller.immutableGenerationId === undefined
            ? {}
            : { immutableGenerationId: args.caller.immutableGenerationId }),
          materialization: materialization.data,
        },
        revalidateMaterialization: revalidateCallerMaterialization,
        ...(revalidateCallerImmutableGeneration
          ? { revalidateImmutableGeneration: revalidateCallerImmutableGeneration }
          : {}),
      })
      : null;
    const admissionCallerNoLongerCurrent = async (): Promise<
      Readonly<{ ok: false; errorCode: string; error: string }> | null
    > => {
      // A host that cannot prove the exact stamped caller is still current
      // must not make the durable write at all.
      const currentness = await revalidateCaller?.()
        ?? { kind: 'materializationUnavailable' as const };
      if (currentness.kind === 'current') return null;
      return failure(currentness.kind === 'generationUnavailable'
        ? 'automation_conversation_caller_generation_unavailable'
        : 'automation_conversation_caller_materialization_unavailable');
    };
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
            }),
          );
          return {
            actionRef: input.resultDelivery.actionRef,
            replyContextEnvelope: sealAutomationConversationReplyContextStoredEnvelopeV1({
              mode: 'plain',
              correspondence: { automationId: input.automationId, occurrenceKey },
              templateVersion: input.templateVersion,
              opaqueContext: input.resultDelivery.opaqueContext,
            }),
          };
        })();
      const callerNoLongerCurrent = await admissionCallerNoLongerCurrent();
      if (callerNoLongerCurrent) return callerNoLongerCurrent;
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
          templateVersion: input.templateVersion,
          opaqueContext: input.resultDelivery.opaqueContext,
        }),
      };
    const request = AutomationConversationAdmitEncryptedHttpRequestV1Schema.parse({
      v: 1,
      caller,
      hostEvidence: {
        v: 1,
        t: 'encrypted',
        accountCurrentness: accountEncryption.witness,
        automationId: input.automationId,
        templateVersion: input.templateVersion,
        occurrenceKey,
        occurredAt: input.occurredAt,
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
    const callerNoLongerCurrent = await admissionCallerNoLongerCurrent();
    if (callerNoLongerCurrent) return callerNoLongerCurrent;
    return await transport.execute('automation.conversation.admit', request, args.signal);
  };
}
