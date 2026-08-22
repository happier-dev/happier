import axios from 'axios';

import {
  AUTOMATION_EVENT_STORED_DEFINITIONS_READ_HTTP_PATH_V1,
  AutomationEventSourceDefinitionV1Schema,
  AutomationEventStoredDefinitionsReadHttpRequestV1Schema,
  AutomationEventStoredDefinitionsReadResultV1Schema,
  AutomationEventTriggerDefinitionStoredPayloadV1Schema,
  AutomationTriggerDefinitionBindingV1Schema,
  PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
  compilePluginJsonSchema,
  openAutomationTriggerDefinitionStoredEnvelopeV1,
  parseAutomationRunExecutionRecipeV1,
  serializeAutomationRunExecutionRecipeV1,
  validateAutomationRunExecutionRecipeOuterV1,
  type AccountEncryptionCurrentnessResponse,
  type AccountScopedCryptoMaterialSnapshotV1,
  type AutomationEventDeclarationReleaseV1,
  type AutomationEventStoredDefinitionProjectionV1,
  type AutomationEventSourcesListInputV1,
  type AutomationEventSourcesListTransportV1,
  type PluginJsonSchemaValidator,
  type PluginMachineMaterializationRefV1,
  type PluginWebhookInvocationReferenceV1,
} from '@happier-dev/protocol';

import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { configuration } from '@/configuration';
import { createDefaultPluginInstallationPublisherHeader } from '@/plugins/installations/publisherProof';
import {
  createAutomationAccountEncryptionMaterialSnapshotV1,
  isAvailableE2eeAutomationAccountEncryptionV1,
  resolveValidatedAutomationAccountEncryptionV1,
} from '@/plugins/runtime/automations/automationAccountCurrentness';
import type { StoredCredentials } from '@/persistence';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';

import {
  createAutomationEventAdoptedDefinitionSetV1,
  type AutomationEventAdoptedDefinitionForAdmissionV1,
  type AutomationEventAdoptedDefinitionSetWithHistoryGapRecoveryV1,
} from './automationEventAdoptedDefinitionSet';

export type AutomationEventStoredDefinitionsHttpTransportV1 = Readonly<{
  read(params: Readonly<{
    caller: PluginMachineMaterializationRefV1;
    input: AutomationEventSourcesListInputV1;
    webhookInvocationReference?: PluginWebhookInvocationReferenceV1;
    signal?: AbortSignal;
  }>): Promise<unknown>;
}>;

/**
 * The one host-private HTTP hop for stored Event definitions. Its caller is
 * stamped from the current generation; no plugin Action or SDK request can
 * create this body.
 */
export function createAutomationEventStoredDefinitionsHttpTransportV1(params: Readonly<{
  credentials: StoredCredentials;
}>): AutomationEventStoredDefinitionsHttpTransportV1 {
  return Object.freeze({
    async read(request) {
      const body = AutomationEventStoredDefinitionsReadHttpRequestV1Schema.parse({
        v: 1,
        caller: {
          pluginId: request.caller.pluginId,
          materialization: request.caller,
        },
        input: request.input,
        ...(request.webhookInvocationReference === undefined
          ? {}
          : { webhookInvocationReference: request.webhookInvocationReference }),
      });
      const publisherHeader = await createDefaultPluginInstallationPublisherHeader({
        method: 'POST',
        path: AUTOMATION_EVENT_STORED_DEFINITIONS_READ_HTTP_PATH_V1,
        body,
      });
      if (!publisherHeader) throw new Error('automation_event_publisher_proof_unavailable');
      request.signal?.throwIfAborted();
      const response = await axios.post(
        `${resolveServerHttpBaseUrl()}${AUTOMATION_EVENT_STORED_DEFINITIONS_READ_HTTP_PATH_V1}`,
        body,
        {
          headers: {
            ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
            Authorization: `Bearer ${params.credentials.token}`,
            [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: publisherHeader,
          },
          timeout: configuration.sessionControlHttpTimeoutMs,
          validateStatus: (status) => status >= 200 && status < 300,
          ...(request.signal ? { signal: request.signal } : {}),
        },
      );
      return AutomationEventStoredDefinitionsReadResultV1Schema.parse(response.data);
    },
  });
}

function createEmptySignal(): AbortSignal {
  return new AbortController().signal;
}

async function projectStoredDefinition(params: Readonly<{
  storedDefinition: AutomationEventStoredDefinitionProjectionV1;
  eventDeclarationRelease: AutomationEventDeclarationReleaseV1;
  transport: AutomationEventSourcesListTransportV1;
  resolveAccountEncryptionCurrentness: (
    signal?: AbortSignal,
  ) => Promise<AccountEncryptionCurrentnessResponse>;
  resolveAccountEncryptionMaterial: (
    signal?: AbortSignal,
  ) => Promise<AccountScopedCryptoMaterialSnapshotV1 | null>;
  signal?: AbortSignal;
}>): Promise<AutomationEventAdoptedDefinitionForAdmissionV1 | null> {
  const signal = params.signal ?? createEmptySignal();
  const accountEncryption = await resolveValidatedAutomationAccountEncryptionV1({
    signal,
    resolveAccountEncryptionCurrentness: params.resolveAccountEncryptionCurrentness,
    resolveAccountEncryptionMaterial: params.resolveAccountEncryptionMaterial,
  });
  if (
    signal.aborted
    || accountEncryption.kind !== 'available'
  ) return null;

  const binding = AutomationTriggerDefinitionBindingV1Schema.parse({
    v: 1,
    automationId: params.storedDefinition.automationId,
    templateVersion: params.storedDefinition.templateVersion,
    triggerKind: 'pluginEvent',
    eventRef: params.storedDefinition.eventRef,
    sourceSelectorId: params.storedDefinition.sourceSelectorId,
  });
  const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({
    mode: accountEncryption.witness.mode,
    binding,
    envelope: params.storedDefinition.storedDefinitionEnvelope,
    ...(isAvailableE2eeAutomationAccountEncryptionV1(accountEncryption)
      ? { material: accountEncryption.material.material }
      : {}),
  });
  if (opened.kind !== 'available') return null;
  const payload = AutomationEventTriggerDefinitionStoredPayloadV1Schema.safeParse(
    opened.definition,
  );
  if (!payload.success) return null;
  const parsedExecutionRecipe = parseAutomationRunExecutionRecipeV1(
    params.storedDefinition.executionRecipe,
  );
  if (parsedExecutionRecipe.kind !== 'available') return null;
  const executionRecipe = validateAutomationRunExecutionRecipeOuterV1({
    recipe: parsedExecutionRecipe.recipe,
    accountCurrentness: accountEncryption.witness,
  });
  if (
    executionRecipe.kind !== 'available'
    || executionRecipe.recipe.templateVersion !== params.storedDefinition.templateVersion
    || executionRecipe.recipe.triggerEvidence !== null
  ) return null;
  const canonicalExecutionRecipe = serializeAutomationRunExecutionRecipeV1(
    executionRecipe.recipe,
  );
  if (canonicalExecutionRecipe.kind !== 'available') return null;
  let payloadValidator: PluginJsonSchemaValidator;
  try {
    payloadValidator = compilePluginJsonSchema(params.storedDefinition.payloadSchema);
  } catch {
    return null;
  }
  if (params.transport.kind !== params.storedDefinition.observationTransport.kind) return null;
  const projected = AutomationEventSourceDefinitionV1Schema.safeParse({
    automationId: params.storedDefinition.automationId,
    templateVersion: params.storedDefinition.templateVersion,
    eventRef: params.storedDefinition.eventRef,
    sourceInstanceId: payload.data.sourceInstanceId,
    sourceSelectorId: params.storedDefinition.sourceSelectorId,
    sourceContractVersion: params.storedDefinition.sourceContractVersion,
    sourceConfig: payload.data.sourceConfig,
    observationTransport: params.storedDefinition.observationTransport,
    filter: payload.data.filter,
    maximumObservationAgeMs: payload.data.maximumObservationAgeMs,
  });
  if (!projected.success) return null;
  if (projected.data.observationTransport.kind === 'durablePush') {
    if (payload.data.webhookRoutingSourceInstanceId === undefined) return null;
    return {
      definition: {
        ...projected.data,
        webhookRoutingSourceInstanceId: payload.data.webhookRoutingSourceInstanceId,
      },
      executionRecipe: canonicalExecutionRecipe.serialized,
      payloadValidator,
      eventDeclarationRelease: params.eventDeclarationRelease,
    };
  }
  return payload.data.webhookRoutingSourceInstanceId === undefined
    ? {
      definition: projected.data,
      executionRecipe: canonicalExecutionRecipe.serialized,
      payloadValidator,
      eventDeclarationRelease: params.eventDeclarationRelease,
    }
    : null;
}

/**
 * Composes the existing exact current-generation and Account-currentness
 * owners into one E3 definition set. It starts no work itself; its consumer
 * explicitly refreshes and may expose only the resulting adopted lookup.
 * Stored definitions are opened only after the generation-local Account
 * currentness/material owner approves their exact current mode.
 */
export function createAutomationEventAdoptedDefinitionSetHostV1(params: Readonly<{
  credentials: StoredCredentials;
  caller: PluginMachineMaterializationRefV1;
  transport: AutomationEventSourcesListTransportV1;
  generationSignal: AbortSignal;
  isGenerationCurrent(): boolean;
  revalidateCallerMaterialization(
    caller: PluginMachineMaterializationRefV1,
    signal?: AbortSignal,
  ): Promise<boolean>;
  readStoredDefinitions?: AutomationEventStoredDefinitionsHttpTransportV1['read'];
  resolveAccountEncryptionCurrentness?: (
    signal?: AbortSignal,
  ) => Promise<AccountEncryptionCurrentnessResponse>;
  resolveAccountEncryptionMaterial?: (
    signal?: AbortSignal,
  ) => Promise<AccountScopedCryptoMaterialSnapshotV1 | null>;
}>): AutomationEventAdoptedDefinitionSetWithHistoryGapRecoveryV1 {
  const readStoredDefinitions = params.readStoredDefinitions
    ?? createAutomationEventStoredDefinitionsHttpTransportV1({
      credentials: params.credentials,
    }).read;
  const resolveAccountEncryptionCurrentness = params.resolveAccountEncryptionCurrentness
    ?? (async (signal?: AbortSignal) => await fetchAccountEncryptionCurrentness({
      token: params.credentials.token,
      ...(signal ? { signal } : {}),
    }));
  const resolveAccountEncryptionMaterial = params.resolveAccountEncryptionMaterial
    ?? (async (_signal?: AbortSignal) =>
      createAutomationAccountEncryptionMaterialSnapshotV1(params.credentials));
  const revalidateAccountContent = async (signal?: AbortSignal): Promise<boolean> => {
    const accountEncryption = await resolveValidatedAutomationAccountEncryptionV1({
      signal: signal ?? createEmptySignal(),
      resolveAccountEncryptionCurrentness,
      resolveAccountEncryptionMaterial,
    });
    return accountEncryption.kind === 'available';
  };
  const resolveAdmissionAccountEncryption = async (
    signal: AbortSignal,
  ) => {
    const accountEncryption = await resolveValidatedAutomationAccountEncryptionV1({
      signal,
      resolveAccountEncryptionCurrentness,
      resolveAccountEncryptionMaterial,
    });
    return accountEncryption.kind === 'available' ? accountEncryption : null;
  };

  return createAutomationEventAdoptedDefinitionSetV1({
    caller: params.caller,
    transport: params.transport,
    generationSignal: params.generationSignal,
    isGenerationCurrent: params.isGenerationCurrent,
    revalidateCallerMaterialization: params.revalidateCallerMaterialization,
    revalidateAccountContent,
    resolveAdmissionAccountEncryption,
    readStoredDefinitions,
    projectStoredDefinition: async ({ storedDefinition, eventDeclarationRelease, signal }) => await projectStoredDefinition({
      storedDefinition,
      eventDeclarationRelease,
      transport: params.transport,
      resolveAccountEncryptionCurrentness,
      resolveAccountEncryptionMaterial,
      ...(signal ? { signal } : {}),
    }),
  });
}
