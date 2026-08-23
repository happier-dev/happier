import { createHash } from 'node:crypto';

import {
  AutomationEventAdmitHttpRequestV1Schema,
  AutomationEventAdmitInputV1Schema,
  MAX_AUTOMATION_EVENT_ADMIT_DEFINITIONS_PER_CALL,
  MAX_AUTOMATION_EVENT_ADMIT_HTTP_REQUEST_UTF8_BYTES,
  AutomationEventSourceDefinitionV1Schema,
  AutomationEventStoredDefinitionsReadResultV1Schema,
  AutomationEventSourcesListInputV1Schema,
  AutomationEventSourcesListResultV1Schema,
  PluginEventAutomationHistoryGapResetActionInputV1Schema,
  MAX_AUTOMATION_EVENT_SOURCE_DEFINITIONS_PER_PAGE,
  buildAutomationPluginEventOccurrenceEvidenceV1,
  createCanonicalJsonSigningInput,
  deriveAutomationEventTriggerEvidenceEqualityTagV1,
  deriveAutomationOccurrenceKeyV1,
  decodeBase64,
  encodeBase64,
  evaluateAutomationEventFilterV1,
  isAutomationEventObservationFreshV1,
  isSameAutomationEventDeclarationReleaseV1,
  isValidPluginJsonSchemaValue,
  readAutomationEventAdmitHttpRequestCanonicalUtf8ByteLengthV1,
  freezeAutomationRunPluginEventExecutionRecipeV1,
  sameAutomationAccountContentIdentityV1,
  sealAutomationEventTriggerEvidenceEnvelopeV1,
  sealAutomationRunPluginEventTriggerEvidenceEnvelopeV1,
  type AutomationEventSourceDefinitionV1,
  type AutomationEventActionHttpCallerV1,
  type AutomationEventAdmitEncryptedDefinitionEvidenceV1,
  type AutomationEventAdmitHttpRequestV1,
  type AutomationEventAdmitInputV1,
  type AutomationAccountCurrentnessWitnessV1,
  type AutomationEventDeclarationReleaseV1,
  type AutomationEventStoredDefinitionProjectionV1,
  type AutomationEventStoredDefinitionsReadResultV1,
  type AutomationEventSourcesListInputV1,
  type AutomationEventSourcesListResultV1,
  type AutomationEventSourcesListTransportV1,
  type PluginJsonSchemaValidator,
  type PluginMachineMaterializationRefV1,
  type PluginEventAutomationHistoryGapResetActionInputV1,
  type PluginWebhookInvocationReferenceV1,
} from '@happier-dev/protocol';

import {
  isAvailableE2eeAutomationAccountEncryptionV1,
  type AvailableAutomationAccountEncryptionV1,
} from './automationAccountCurrentness';
import { readCurrentPluginWebhookInvocationReferenceV1 } from '../webhooks/pluginWebhookInvocationReference';

export type AutomationEventAdoptedDefinitionSetRefreshResultV1 =
  | Readonly<{ kind: 'adopted'; revision: string }>
  | Readonly<{ kind: 'unchanged'; revision: string }>
  | Readonly<{
      kind: 'discarded';
      reason: 'cursorStale' | 'invalidPage' | 'notCurrent' | 'unavailable';
    }>;

/**
 * Host-only extension of the unchanged public source definition. The generic
 * endpoint-routing source is private routing evidence, never Action output.
 */
export type AutomationEventAdoptedDefinitionV1 = AutomationEventSourceDefinitionV1 & Readonly<{
  webhookRoutingSourceInstanceId?: string;
}>;

/**
 * The private companion atomically adopted with a public Event source
 * definition. It never reaches plugin Action output; only its bounded release
 * witness accompanies encrypted host evidence so the server can reject a
 * validator prepared from a superseded Event declaration.
 */
export type AutomationEventAdoptedDefinitionForAdmissionV1 = Readonly<{
  definition: AutomationEventAdoptedDefinitionV1;
  /** Canonical strict definition recipe with `triggerEvidence:null`. */
  executionRecipe: string;
  payloadValidator: PluginJsonSchemaValidator;
  /** Immutable release that supplied this compiled Event payload validator. */
  eventDeclarationRelease: AutomationEventDeclarationReleaseV1;
}>;

type AutomationEventAdoptedDefinitionSnapshotRecordV1 = Readonly<{
  definition: AutomationEventAdoptedDefinitionV1;
  executionRecipe: string | null;
  payloadValidator: PluginJsonSchemaValidator | null;
  eventDeclarationRelease: AutomationEventDeclarationReleaseV1 | null;
}>;

function isDefinitionPreparedForAdmission(
  value: AutomationEventAdoptedDefinitionV1 | AutomationEventAdoptedDefinitionForAdmissionV1,
): value is AutomationEventAdoptedDefinitionForAdmissionV1 {
  return 'definition' in value;
}

export type AutomationEventAdoptedDefinitionPublicProjectionResultV1 =
  | AutomationEventSourcesListResultV1
  | Readonly<{ kind: 'unavailable' }>;

/** One private E3-to-E2 sequence of complete bounded admission requests. */
export type AutomationEventAdmitPreparedRequestSequenceV1 = AsyncIterableIterator<
  AutomationEventAdmitHttpRequestV1,
  void,
  AutomationAccountCurrentnessWitnessV1 | undefined
>;

export type AutomationEventAdoptedDefinitionSetV1 = Readonly<{
  refresh(signal?: AbortSignal): Promise<AutomationEventAdoptedDefinitionSetRefreshResultV1>;
  readPublicProjection():
    | Readonly<{ kind: 'initializing' }>
    | Readonly<{
        kind: 'available';
        revision: string;
        definitions: readonly AutomationEventSourceDefinitionV1[];
      }>;
  listPublicProjection(params: Readonly<{
    accountId: string;
    input: AutomationEventSourcesListInputV1;
    /** Host-only claimed delivery context; never originates in Action input. */
    webhookInvocationReference?: PluginWebhookInvocationReferenceV1;
    signal?: AbortSignal;
  }>): Promise<AutomationEventAdoptedDefinitionPublicProjectionResultV1>;
  /**
   * Sole E3 host-private admission preparation path. It consumes one immutable
   * adopted snapshot and freezes one Account witness/material set before E2
   * consumes the ordered one-shot sequence of complete server request bodies.
   */
  prepareAdmission(params: Readonly<{
    accountId: string;
    caller: AutomationEventActionHttpCallerV1;
    input: unknown;
    randomBytes: (length: number) => Uint8Array;
    signal?: AbortSignal;
  }>): Promise<AutomationEventAdmitPreparedRequestSequenceV1 | null>;
}>;

/**
 * Host-only extension of the ordinary adopted-set reader. It stays separate
 * from public Event Action consumers so recovery binding does not widen their
 * source-reading authority.
 */
export type AutomationEventAdoptedDefinitionSetHistoryGapRecoveryV1 = Readonly<{
  readCurrentCheckpointedPullSource(params: Readonly<{
    reset: unknown;
    signal?: AbortSignal;
  }>): Promise<AutomationEventSourceDefinitionV1 | null>;
}>;

export type AutomationEventAdoptedDefinitionSetWithHistoryGapRecoveryV1 =
  AutomationEventAdoptedDefinitionSetV1 & AutomationEventAdoptedDefinitionSetHistoryGapRecoveryV1;

type AdoptedSnapshot = Readonly<{
  revision: string;
  storedDefinitionScope: string | undefined;
  eventDeclarationRelease: AutomationEventDeclarationReleaseV1;
  /**
   * The one Account crypto/currentness witness every definition in this
   * snapshot was opened under. Admission requires the Account content identity
   * it names before sealing new evidence against these definitions.
   */
  accountCurrentness: AutomationAccountCurrentnessWitnessV1;
  definitions: readonly AutomationEventAdoptedDefinitionV1[];
  definitionsByAdmissionKey: ReadonlyMap<string, AutomationEventAdoptedDefinitionSnapshotRecordV1>;
}>;

type PublicProjectionCursor = Readonly<{
  v: 1;
  scope: string;
  revision: string;
  lastDefinitionKeyDigest: string;
}>;

type AdoptedSnapshotRefresh = {
  controller: AbortController;
  promise: Promise<AutomationEventAdoptedDefinitionSetRefreshResultV1>;
  waiters: number;
};

function createEmptySignal(): AbortSignal {
  return new AbortController().signal;
}

function cloneDefinition(definition: AutomationEventAdoptedDefinitionV1): AutomationEventAdoptedDefinitionV1 {
  return structuredClone(definition);
}

function projectPublicDefinition(
  definition: AutomationEventAdoptedDefinitionV1,
): AutomationEventSourceDefinitionV1 {
  const { webhookRoutingSourceInstanceId: _webhookRoutingSourceInstanceId, ...publicDefinition } = definition;
  return structuredClone(publicDefinition);
}

function isCanonicalUnsignedRevision(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return value === BigInt(value).toString();
  } catch {
    return false;
  }
}

function compareCanonicalUnsignedRevisions(left: string, right: string): number {
  const leftRevision = BigInt(left);
  const rightRevision = BigInt(right);
  if (leftRevision < rightRevision) return -1;
  if (leftRevision > rightRevision) return 1;
  return 0;
}

function definitionStableKey(definition: Readonly<{
  automationId: string;
  eventRef: Readonly<{ pluginId: string; localId: string }>;
}>): string {
  return [
    definition.automationId,
    definition.eventRef.pluginId,
    definition.eventRef.localId,
  ].map((part) => `${part.length}:${part}`).join('|');
}

function createPublicProjectionScopeFingerprint(params: Readonly<{
  accountId: string;
  caller: PluginMachineMaterializationRefV1;
  transport: AutomationEventSourcesListTransportV1;
  storedDefinitionScope?: string;
  webhookInvocationScope?: Readonly<{
    webhookEndpointId: string;
    endpointRevision: number;
    sourceInstanceId: string;
  }>;
}>): string {
  return createHash('sha256')
    .update(createCanonicalJsonSigningInput(params), 'utf8')
    .digest('base64url');
}

function publicProjectionDefinitionKeyDigest(
  definition: AutomationEventAdoptedDefinitionV1,
): string {
  return createHash('sha256')
    .update(definitionStableKey(definition), 'utf8')
    .digest('base64url');
}

function encodePublicProjectionCursor(cursor: PublicProjectionCursor): string {
  return encodeBase64(new TextEncoder().encode(JSON.stringify(cursor)), 'base64url');
}

function decodePublicProjectionCursor(cursor: string): PublicProjectionCursor | null {
  try {
    const bytes = decodeBase64(cursor, 'base64url');
    if (encodeBase64(bytes, 'base64url') !== cursor) return null;
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Readonly<Record<string, unknown>>;
    if (
      Object.keys(record).length !== 4
      || record.v !== 1
      || typeof record.scope !== 'string'
      || !isCanonicalUnsignedRevision(record.revision)
      || typeof record.lastDefinitionKeyDigest !== 'string'
      || !/^[A-Za-z0-9_-]{43}$/u.test(record.lastDefinitionKeyDigest)
    ) return null;
    const parsed: PublicProjectionCursor = {
      v: 1,
      scope: record.scope,
      revision: record.revision,
      lastDefinitionKeyDigest: record.lastDefinitionKeyDigest,
    };
    return encodePublicProjectionCursor(parsed) === cursor ? parsed : null;
  } catch {
    return null;
  }
}

function sameTransport(
  left: AutomationEventSourcesListTransportV1,
  right: AutomationEventSourcesListTransportV1,
): boolean {
  try {
    return createCanonicalJsonSigningInput(left) === createCanonicalJsonSigningInput(right);
  } catch {
    return false;
  }
}

/**
 * The canonical identity of one admission selector. Every host owner that has
 * to decide whether two selectors are the same definition uses this exact
 * encoding, so a repeated selector groups identically wherever it is read.
 */
export function admissionKey(params: Readonly<{
  automationId: string;
  templateVersion: number;
  sourceSelectorId: string;
}>): string {
  return [
    params.automationId,
    String(params.templateVersion),
    params.sourceSelectorId,
  ].map((part) => `${part.length}:${part}`).join('|');
}

function sameMaterialization(
  left: PluginMachineMaterializationRefV1,
  right: PluginMachineMaterializationRefV1,
): boolean {
  return left.pluginId === right.pluginId
    && left.machineId === right.machineId
    && left.materializationId === right.materializationId;
}

function matchesDurableWebhookInvocation(params: Readonly<{
  definition: AutomationEventAdoptedDefinitionV1;
  reference: PluginWebhookInvocationReferenceV1;
  caller: PluginMachineMaterializationRefV1;
}>): boolean {
  const transport = params.definition.observationTransport;
  return transport.kind === 'durablePush'
    && transport.webhookEndpointId === params.reference.endpoint.webhookEndpointId
    && sameMaterialization(transport.endpointMaterializationRef, params.caller)
    && params.definition.webhookRoutingSourceInstanceId
      === params.reference.endpoint.sourceInstanceId;
}

function sameEventRef(
  left: Readonly<{ pluginId: string; localId: string }>,
  right: Readonly<{ pluginId: string; localId: string }>,
): boolean {
  return left.pluginId === right.pluginId && left.localId === right.localId;
}

function isExactAdoptedDefinitionForPreparation(params: Readonly<{
  definition: AutomationEventAdoptedDefinitionV1;
  selector: AutomationEventAdmitInputV1['definitions'][number];
  eventRef: AutomationEventAdmitInputV1['eventRef'];
  caller: PluginMachineMaterializationRefV1;
  transport: AutomationEventSourcesListTransportV1;
}>): boolean {
  const { definition } = params;
  if (
    definition.automationId !== params.selector.automationId
    || definition.templateVersion !== params.selector.templateVersion
    || definition.sourceSelectorId !== params.selector.sourceSelectorId
    || !sameEventRef(definition.eventRef, params.eventRef)
    || definition.eventRef.pluginId !== params.caller.pluginId
    || definition.observationTransport.kind !== params.transport.kind
  ) return false;

  return definition.observationTransport.kind === 'checkpointedPull'
    ? sameMaterialization(
      definition.observationTransport.watcherMaterializationRef,
      params.caller,
    )
    : sameMaterialization(
      definition.observationTransport.endpointMaterializationRef,
      params.caller,
    );
}

function readExactDurablePushInvocationReference(params: Readonly<{
  selectedDefinitions: readonly AutomationEventAdoptedDefinitionSnapshotRecordV1[];
  caller: PluginMachineMaterializationRefV1;
}>): PluginWebhookInvocationReferenceV1 | null {
  const reference = readCurrentPluginWebhookInvocationReferenceV1();
  if (!reference) return null;
  const matchesEveryDefinition = params.selectedDefinitions.every(({ definition }) => (
    matchesDurableWebhookInvocation({ definition, reference, caller: params.caller })
    && reference.endpoint.webhookContribution.pluginId === params.caller.pluginId
    && sameMaterialization(reference.target.materialization, params.caller)
  ));
  return matchesEveryDefinition ? reference : null;
}

function projectionMatchesStoredDefinition(
  storedDefinition: AutomationEventStoredDefinitionProjectionV1,
  definition: AutomationEventSourceDefinitionV1,
): boolean {
  if (
    definition.automationId !== storedDefinition.automationId
    || definition.templateVersion !== storedDefinition.templateVersion
    || definition.eventRef.pluginId !== storedDefinition.eventRef.pluginId
    || definition.eventRef.localId !== storedDefinition.eventRef.localId
    || definition.sourceSelectorId !== storedDefinition.sourceSelectorId
    || definition.sourceContractVersion !== storedDefinition.sourceContractVersion
  ) {
    return false;
  }
  try {
    return createCanonicalJsonSigningInput(definition.observationTransport)
      === createCanonicalJsonSigningInput(storedDefinition.observationTransport);
  } catch {
    return false;
  }
}

/**
 * Owns one generation-local, complete source-definition set. It does not
 * schedule scans, retain data across generations, or expose stored envelopes
 * to provider code. The caller supplies the already-authoritative server read,
 * Account-crypto projection, and lifecycle/currentness owners.
 */
export function createAutomationEventAdoptedDefinitionSetV1(params: Readonly<{
  caller: PluginMachineMaterializationRefV1;
  transport: AutomationEventSourcesListTransportV1;
  pageSize?: number;
  generationSignal: AbortSignal;
  isGenerationCurrent(): boolean;
  revalidateCallerMaterialization(
    caller: PluginMachineMaterializationRefV1,
    signal?: AbortSignal,
  ): Promise<boolean>;
  /**
   * The one Account crypto/currentness owner for this set. A refresh attempt
   * resolves it once and reuses that immutable snapshot; every other path
   * resolves a fresh one at its own boundary.
   */
  resolveAccountEncryption(
    signal?: AbortSignal,
  ): Promise<AvailableAutomationAccountEncryptionV1 | null>;
  readStoredDefinitions(params: Readonly<{
    caller: PluginMachineMaterializationRefV1;
    input: AutomationEventSourcesListInputV1;
    webhookInvocationReference?: PluginWebhookInvocationReferenceV1;
    signal?: AbortSignal;
  }>): Promise<unknown>;
  projectStoredDefinition(params: Readonly<{
    storedDefinition: AutomationEventStoredDefinitionProjectionV1;
    eventDeclarationRelease: AutomationEventDeclarationReleaseV1;
    accountEncryption: AvailableAutomationAccountEncryptionV1;
    signal?: AbortSignal;
  }>): Promise<
    AutomationEventAdoptedDefinitionV1 | AutomationEventAdoptedDefinitionForAdmissionV1 | null
  >;
}>): AutomationEventAdoptedDefinitionSetWithHistoryGapRecoveryV1 {
  const pageSize = params.pageSize ?? MAX_AUTOMATION_EVENT_SOURCE_DEFINITIONS_PER_PAGE;
  let adopted: AdoptedSnapshot | null = null;
  // Joins only same-cycle currentness reads; `adopted` remains the one
  // retained definition snapshot.
  let adoptedSnapshotRefresh: AdoptedSnapshotRefresh | null = null;

  function isGenerationCurrent(signal: AbortSignal): boolean {
    return !signal.aborted && !params.generationSignal.aborted && params.isGenerationCurrent();
  }

  /**
   * Generation and caller-materialization currentness only. Both are local
   * comparisons against the host's current admitted generation, so they carry
   * no remote cost and stay on every per-definition step.
   */
  async function isCallerCurrent(signal: AbortSignal): Promise<boolean> {
    if (!isGenerationCurrent(signal)) return false;
    try {
      if (!await params.revalidateCallerMaterialization(params.caller, signal)) return false;
    } catch {
      return false;
    }
    return isGenerationCurrent(signal);
  }

  /**
   * Caller currentness plus one fresh Account crypto/currentness reading. When
   * `expected` is supplied, the reading must still name the same Account
   * content identity — the mode and key the caller already opened content
   * under. The Account change version advances for unrelated Account writes,
   * so it is deliberately not part of that comparison.
   */
  async function isCurrent(
    signal: AbortSignal,
    expected?: AutomationAccountCurrentnessWitnessV1,
  ): Promise<boolean> {
    return await readCurrentAccountEncryption(signal, expected) !== null;
  }

  async function readCurrentAccountEncryption(
    signal: AbortSignal,
    expected?: AutomationAccountCurrentnessWitnessV1,
  ): Promise<AvailableAutomationAccountEncryptionV1 | null> {
    if (!await isCallerCurrent(signal)) return null;
    let encryption: AvailableAutomationAccountEncryptionV1 | null;
    try {
      encryption = await params.resolveAccountEncryption(signal);
    } catch {
      return null;
    }
    if (encryption === null || !isGenerationCurrent(signal)) return null;
    return expected === undefined
      || sameAutomationAccountContentIdentityV1(encryption.witness, expected)
      ? encryption
      : null;
  }

  function listInput(paramsForPage: Readonly<{
    cursor?: string;
    knownRevision?: string;
  }>): AutomationEventSourcesListInputV1 {
    return AutomationEventSourcesListInputV1Schema.parse({
      transport: params.transport,
      pageSize,
      ...(paramsForPage.cursor === undefined ? {} : { cursor: paramsForPage.cursor }),
      ...(paramsForPage.knownRevision === undefined ? {} : { knownRevision: paramsForPage.knownRevision }),
    });
  }

  function buildSnapshot(
    revision: string,
    storedDefinitionScope: string | undefined,
    eventDeclarationRelease: AutomationEventDeclarationReleaseV1,
    accountCurrentness: AutomationAccountCurrentnessWitnessV1,
    definitions: readonly (
      AutomationEventAdoptedDefinitionV1 | AutomationEventAdoptedDefinitionForAdmissionV1
    )[],
  ): AdoptedSnapshot | null {
    if (params.transport.kind === 'durablePush' && storedDefinitionScope === undefined) return null;
    const definitionsByAdmissionKey = new Map<string, AutomationEventAdoptedDefinitionSnapshotRecordV1>();
    const immutableDefinitions = definitions.map((candidate) => cloneDefinition(
      isDefinitionPreparedForAdmission(candidate) ? candidate.definition : candidate,
    ));
    for (let index = 0; index < immutableDefinitions.length; index += 1) {
      const definition = immutableDefinitions[index]!;
      const privateDefinition = definitions[index]!;
      const key = admissionKey(definition);
      if (definitionsByAdmissionKey.has(key)) return null;
      const declarationRelease = isDefinitionPreparedForAdmission(privateDefinition)
        ? privateDefinition.eventDeclarationRelease
        : null;
      if (
        declarationRelease !== null
        && !isSameAutomationEventDeclarationReleaseV1(eventDeclarationRelease, declarationRelease)
      ) return null;
      definitionsByAdmissionKey.set(key, {
        definition,
        executionRecipe: isDefinitionPreparedForAdmission(privateDefinition)
          ? structuredClone(privateDefinition.executionRecipe)
          : null,
        payloadValidator: isDefinitionPreparedForAdmission(privateDefinition)
          ? privateDefinition.payloadValidator
          : null,
        eventDeclarationRelease: declarationRelease,
      });
    }
    return {
      revision,
      storedDefinitionScope,
      eventDeclarationRelease,
      accountCurrentness,
      definitions: immutableDefinitions,
      definitionsByAdmissionKey,
    };
  }

  async function refresh(
    callerSignal = createEmptySignal(),
  ): Promise<AutomationEventAdoptedDefinitionSetRefreshResultV1> {
    const signal = AbortSignal.any([params.generationSignal, callerSignal]);
    // One immutable Account crypto/currentness snapshot for the whole attempt.
    // The adopted catalog publishes atomically, so nothing built under it is
    // observable before the closing recheck admits it; re-reading the Account
    // once per definition bought no guarantee the boundary rechecks do not.
    const attemptAccountEncryption = await readCurrentAccountEncryption(signal);
    if (attemptAccountEncryption === null) return { kind: 'discarded', reason: 'notCurrent' };
    const attemptAccountCurrentness = attemptAccountEncryption.witness;

    let cursor: string | undefined;
    let expectedRevision: string | undefined;
    let expectedEventDeclarationRelease: AutomationEventDeclarationReleaseV1 | undefined;
    let expectedStoredDefinitionScope: string | undefined;
    let hasExpectedStoredDefinitionScope = false;
    let firstPage = true;
    let previousStableKey: string | undefined;
    const seenCursors = new Set<string>();
    const seenStableKeys = new Set<string>();
    const candidate: Array<
      AutomationEventAdoptedDefinitionV1 | AutomationEventAdoptedDefinitionForAdmissionV1
    > = [];

    let useAuthoritativeRead = false;
    while (true) {
      let result: AutomationEventStoredDefinitionsReadResultV1;
      try {
        const parsed = AutomationEventStoredDefinitionsReadResultV1Schema.safeParse(
          await params.readStoredDefinitions({
            caller: params.caller,
            input: listInput({
              ...(cursor === undefined && adopted !== null && !useAuthoritativeRead
                ? { knownRevision: adopted.revision }
                : {}),
              ...(cursor === undefined ? {} : { cursor }),
            }),
            signal,
          }),
        );
        if (!parsed.success) return { kind: 'discarded', reason: 'invalidPage' };
        result = parsed.data;
      } catch {
        return signal.aborted
          ? { kind: 'discarded', reason: 'notCurrent' }
          : { kind: 'discarded', reason: 'unavailable' };
      }
      // Page boundary: the attempt's Account content identity must still hold.
      if (!await isCurrent(signal, attemptAccountCurrentness)) {
        return { kind: 'discarded', reason: 'notCurrent' };
      }

      if (result.kind === 'cursorStale') {
        return isCanonicalUnsignedRevision(result.currentRevision)
          ? { kind: 'discarded', reason: 'cursorStale' }
          : { kind: 'discarded', reason: 'invalidPage' };
      }
      if (result.kind === 'unchanged') {
        if (!firstPage || adopted === null || result.revision !== adopted.revision
          || !isCanonicalUnsignedRevision(result.revision)) {
          return { kind: 'discarded', reason: 'invalidPage' };
        }
        if (!isSameAutomationEventDeclarationReleaseV1(
          result.eventDeclarationRelease,
          adopted.eventDeclarationRelease,
        )) {
          if (useAuthoritativeRead) return { kind: 'discarded', reason: 'invalidPage' };
          // The Event catalog revision intentionally does not change for a
          // release-only declaration update. Re-adopt one complete snapshot so
          // E3 never keeps a compiled validator after its declaration release
          // advanced.
          useAuthoritativeRead = true;
          continue;
        }
        if (params.transport.kind === 'durablePush') {
          if (typeof result.scope !== 'string') {
            return { kind: 'discarded', reason: 'invalidPage' };
          }
          if (result.scope !== adopted.storedDefinitionScope) {
            if (useAuthoritativeRead) return { kind: 'discarded', reason: 'invalidPage' };
            // The catalog revision deliberately did not move. Rebuild from the
            // canonical reader so the endpoint-scoped adopted set changes as
            // one unit instead of treating the old set as current.
            useAuthoritativeRead = true;
            continue;
          }
        }
        return { kind: 'unchanged', revision: result.revision };
      }
      if (!isCanonicalUnsignedRevision(result.revision)
        || (expectedRevision !== undefined && result.revision !== expectedRevision)
        || (result.nextCursor !== null && result.definitions.length === 0)) {
        return { kind: 'discarded', reason: 'invalidPage' };
      }
      expectedRevision ??= result.revision;
      if (
        expectedEventDeclarationRelease !== undefined
        && !isSameAutomationEventDeclarationReleaseV1(
          expectedEventDeclarationRelease,
          result.eventDeclarationRelease,
        )
      ) return { kind: 'discarded', reason: 'invalidPage' };
      expectedEventDeclarationRelease ??= result.eventDeclarationRelease;
      if (params.transport.kind === 'durablePush' && typeof result.scope !== 'string') {
        return { kind: 'discarded', reason: 'invalidPage' };
      }
      if (!hasExpectedStoredDefinitionScope) {
        expectedStoredDefinitionScope = result.scope;
        hasExpectedStoredDefinitionScope = true;
      } else if (result.scope !== expectedStoredDefinitionScope) {
        return { kind: 'discarded', reason: 'invalidPage' };
      }

      for (const storedDefinition of result.definitions) {
        const stableKey = definitionStableKey(storedDefinition);
        if (
          seenStableKeys.has(stableKey)
          || (previousStableKey !== undefined && stableKey <= previousStableKey)
        ) {
          return { kind: 'discarded', reason: 'invalidPage' };
        }
        let projected:
          | AutomationEventAdoptedDefinitionV1
          | AutomationEventAdoptedDefinitionForAdmissionV1
          | null;
        try {
          projected = await params.projectStoredDefinition({
            storedDefinition,
            eventDeclarationRelease: result.eventDeclarationRelease,
            accountEncryption: attemptAccountEncryption,
            signal,
          });
        } catch {
          return { kind: 'discarded', reason: 'unavailable' };
        }
        if (!await isCallerCurrent(signal)) return { kind: 'discarded', reason: 'notCurrent' };
        if (projected === null) return { kind: 'discarded', reason: 'invalidPage' };
        const projectedDefinition = isDefinitionPreparedForAdmission(projected)
          ? projected.definition
          : projected;
        const { webhookRoutingSourceInstanceId, ...publicProjection } = projectedDefinition;
        const parsed = AutomationEventSourceDefinitionV1Schema.safeParse(publicProjection);
        if (
          !parsed.success
          || !projectionMatchesStoredDefinition(storedDefinition, parsed.data)
          || (
            parsed.data.observationTransport.kind === 'durablePush'
            && typeof webhookRoutingSourceInstanceId !== 'string'
          )
          || (
            parsed.data.observationTransport.kind === 'checkpointedPull'
            && webhookRoutingSourceInstanceId !== undefined
          )
        ) {
          return { kind: 'discarded', reason: 'invalidPage' };
        }
        seenStableKeys.add(stableKey);
        previousStableKey = stableKey;
        const definition = webhookRoutingSourceInstanceId === undefined
          ? parsed.data
          : { ...parsed.data, webhookRoutingSourceInstanceId };
        candidate.push(isDefinitionPreparedForAdmission(projected)
          ? {
            definition,
            executionRecipe: projected.executionRecipe,
            payloadValidator: projected.payloadValidator,
            eventDeclarationRelease: projected.eventDeclarationRelease,
          }
          : definition);
      }

      if (result.nextCursor === null) {
        // Closing boundary: admit the candidate only while the Account content
        // identity every definition was opened under is still current.
        if (!await isCurrent(signal, attemptAccountCurrentness)) {
          return { kind: 'discarded', reason: 'notCurrent' };
        }
        const snapshot = buildSnapshot(
          expectedRevision,
          expectedStoredDefinitionScope,
          expectedEventDeclarationRelease!,
          attemptAccountCurrentness,
          candidate,
        );
        if (snapshot === null) return { kind: 'discarded', reason: 'invalidPage' };
        if (
          adopted !== null
          && compareCanonicalUnsignedRevisions(expectedRevision, adopted.revision) < 0
        ) {
          return { kind: 'discarded', reason: 'cursorStale' };
        }
        adopted = snapshot;
        return { kind: 'adopted', revision: expectedRevision };
      }
      if (seenCursors.has(result.nextCursor)) {
        return { kind: 'discarded', reason: 'invalidPage' };
      }
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
      firstPage = false;
    }
  }

  async function validateDurableWebhookInvocation(paramsForValidation: Readonly<{
    snapshot: AdoptedSnapshot;
    reference: PluginWebhookInvocationReferenceV1;
    signal: AbortSignal;
  }>): Promise<'current' | 'refresh' | 'unavailable'> {
    let result: AutomationEventStoredDefinitionsReadResultV1;
    try {
      const parsed = AutomationEventStoredDefinitionsReadResultV1Schema.safeParse(
        await params.readStoredDefinitions({
          caller: params.caller,
          input: listInput({ knownRevision: paramsForValidation.snapshot.revision }),
          webhookInvocationReference: paramsForValidation.reference,
          signal: paramsForValidation.signal,
        }),
      );
      if (!parsed.success) return 'unavailable';
      result = parsed.data;
    } catch {
      return 'unavailable';
    }
    if (!await isCurrent(paramsForValidation.signal)) return 'unavailable';
    // A host-injected delivery reference asks the server to validate one exact
    // endpoint. Its scope is intentionally endpoint-local, whereas the adopted
    // snapshot scope covers every endpoint currently targeted to this caller.
    // The server's reference validation owns exact endpoint currentness.
    return result.kind === 'unchanged'
      && result.revision === paramsForValidation.snapshot.revision
      && typeof result.scope === 'string'
      && isSameAutomationEventDeclarationReleaseV1(
        result.eventDeclarationRelease,
        paramsForValidation.snapshot.eventDeclarationRelease,
      )
      ? 'current'
      : 'refresh';
  }

  function acquireAdoptedSnapshotRefresh(): AdoptedSnapshotRefresh {
    if (adoptedSnapshotRefresh !== null) {
      adoptedSnapshotRefresh.waiters += 1;
      return adoptedSnapshotRefresh;
    }
    const controller = new AbortController();
    const inFlight: AdoptedSnapshotRefresh = {
      controller,
      promise: refresh(controller.signal),
      waiters: 1,
    };
    adoptedSnapshotRefresh = inFlight;
    void inFlight.promise.then(
      () => {
        if (adoptedSnapshotRefresh === inFlight) {
          adoptedSnapshotRefresh = null;
        }
      },
      () => {
        if (adoptedSnapshotRefresh === inFlight) {
          adoptedSnapshotRefresh = null;
        }
      },
    );
    return inFlight;
  }

  async function joinAdoptedSnapshotRefresh(
    signal: AbortSignal,
  ): Promise<AutomationEventAdoptedDefinitionSetRefreshResultV1> {
    if (signal.aborted) return { kind: 'discarded', reason: 'notCurrent' };
    const inFlight = acquireAdoptedSnapshotRefresh();
    try {
      return await new Promise<AutomationEventAdoptedDefinitionSetRefreshResultV1>((resolve) => {
        let settled = false;
        function settle(result: AutomationEventAdoptedDefinitionSetRefreshResultV1): void {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          resolve(result);
        }
        function onAbort(): void {
          settle({ kind: 'discarded', reason: 'notCurrent' });
        }
        signal.addEventListener('abort', onAbort, { once: true });
        void inFlight.promise.then(
          (result) => settle(result),
          () => settle({ kind: 'discarded', reason: 'unavailable' }),
        );
        if (signal.aborted) onAbort();
      });
    } finally {
      inFlight.waiters -= 1;
      if (inFlight.waiters === 0 && adoptedSnapshotRefresh === inFlight) {
        inFlight.controller.abort();
      }
    }
  }

  /**
   * The generation-local owner exists before its first catalog read can
   * succeed, and a transient first read must not strand the plugin for the
   * whole generation. When no snapshot is retained yet, join the one in-flight
   * refresh — or perform it — exactly as a revision-confirming read already
   * does. This adds no retry registry: the single-flight refresh below is the
   * only refresh path, for both transports.
   */
  async function requireAdoptedSnapshot(signal: AbortSignal): Promise<AdoptedSnapshot | null> {
    if (adopted !== null) return adopted;
    const refreshed = await joinAdoptedSnapshotRefresh(signal);
    if (refreshed.kind === 'discarded' || !await isCurrent(signal)) return null;
    return adopted;
  }

  const definitionSet: AutomationEventAdoptedDefinitionSetWithHistoryGapRecoveryV1 = {
    refresh,
    readPublicProjection() {
      if (
        adopted === null
        || params.generationSignal.aborted
        || !params.isGenerationCurrent()
      ) return { kind: 'initializing' };
      return {
        kind: 'available',
        revision: adopted.revision,
        definitions: adopted.definitions.map((definition) => projectPublicDefinition(definition)),
      };
    },
    async readCurrentCheckpointedPullSource(request) {
      const reset = PluginEventAutomationHistoryGapResetActionInputV1Schema.safeParse(request.reset);
      const signal = AbortSignal.any([params.generationSignal, request.signal ?? createEmptySignal()]);
      if (
        !reset.success
        || params.transport.kind !== 'checkpointedPull'
        || !await isCurrent(signal)
      ) return null;

      // A history-gap operation must bind only the Account in the current
      // persisted source. Joining the adopted owner's currentness read avoids
      // a second source registry while fencing selection to this generation.
      const refreshed = await joinAdoptedSnapshotRefresh(signal);
      if (refreshed.kind === 'discarded' || !await isCurrent(signal)) return null;
      const snapshot = adopted;
      if (snapshot === null) return null;
      const selected = snapshot.definitionsByAdmissionKey.get(admissionKey(reset.data));
      if (
        selected === undefined
        || selected.definition.observationTransport.kind !== 'checkpointedPull'
        || !sameMaterialization(
          selected.definition.observationTransport.watcherMaterializationRef,
          params.caller,
        )
        || !await isCurrent(signal)
      ) return null;
      return projectPublicDefinition(selected.definition);
    },
    async listPublicProjection(request) {
      const signal = AbortSignal.any([params.generationSignal, request.signal ?? createEmptySignal()]);
      if (!await isCurrent(signal)) return { kind: 'unavailable' };
      if (
        !request.accountId.trim()
        || !sameTransport(request.input.transport, params.transport)
      ) return { kind: 'unavailable' };
      let snapshot: AdoptedSnapshot | null;
      if (
        params.transport.kind === 'checkpointedPull'
        && request.input.cursor === undefined
        && request.input.knownRevision !== undefined
      ) {
        // A revision-confirming observer read must refresh the one adopted
        // owner before it can publish an unchanged result. Cursor pages stay
        // bound to their already-adopted snapshot.
        const refreshed = await joinAdoptedSnapshotRefresh(signal);
        if (refreshed.kind === 'discarded' || !await isCurrent(signal)) {
          return { kind: 'unavailable' };
        }
        snapshot = adopted;
      } else {
        snapshot = await requireAdoptedSnapshot(signal);
      }
      if (snapshot === null) return { kind: 'unavailable' };
      if (params.transport.kind === 'durablePush') {
        const reference = request.webhookInvocationReference;
        if (reference === undefined) return { kind: 'unavailable' };
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const currentness = await validateDurableWebhookInvocation({
            snapshot,
            reference,
            signal,
          });
          if (currentness === 'current') break;
          if (currentness !== 'refresh' || attempt === 1) return { kind: 'unavailable' };
          // Keep one complete generation-local adopted set. A ref-scoped
          // private confirmation only proves the exact delivery current; a
          // moved catalog revision is rebuilt from the canonical all-target
          // reader before this delivery may receive a public projection.
          const refreshed = await refresh(signal);
          if (refreshed.kind === 'discarded') return { kind: 'unavailable' };
          snapshot = adopted;
          if (snapshot === null) return { kind: 'unavailable' };
        }
      }
      if (snapshot === null) return { kind: 'unavailable' };

      const projectionDefinitions = params.transport.kind === 'durablePush'
        ? snapshot.definitions.filter((definition) => matchesDurableWebhookInvocation({
          definition,
          reference: request.webhookInvocationReference!,
          caller: params.caller,
        }))
        : snapshot.definitions;

      if (request.input.cursor === undefined && request.input.knownRevision === snapshot.revision) {
        return AutomationEventSourcesListResultV1Schema.parse({
          kind: 'unchanged',
          revision: snapshot.revision,
        });
      }

      const scope = createPublicProjectionScopeFingerprint({
        accountId: request.accountId,
        caller: params.caller,
        transport: params.transport,
        ...(snapshot.storedDefinitionScope === undefined
          ? {}
          : { storedDefinitionScope: snapshot.storedDefinitionScope }),
        ...(params.transport.kind === 'durablePush'
          ? {
            webhookInvocationScope: {
              webhookEndpointId: request.webhookInvocationReference!.endpoint.webhookEndpointId,
              endpointRevision: request.webhookInvocationReference!.endpoint.revision,
              sourceInstanceId: request.webhookInvocationReference!.endpoint.sourceInstanceId,
            },
          }
          : {}),
      });
      let startIndex = 0;
      if (request.input.cursor !== undefined) {
        const cursor = decodePublicProjectionCursor(request.input.cursor);
        if (
          cursor === null
          || cursor.scope !== scope
          || cursor.revision !== snapshot.revision
        ) {
          return AutomationEventSourcesListResultV1Schema.parse({
            kind: 'cursorStale',
            currentRevision: snapshot.revision,
          });
        }
        const lastIndex = projectionDefinitions.findIndex((definition) => (
          publicProjectionDefinitionKeyDigest(definition) === cursor.lastDefinitionKeyDigest
        ));
        if (lastIndex < 0) {
          return AutomationEventSourcesListResultV1Schema.parse({
            kind: 'cursorStale',
            currentRevision: snapshot.revision,
          });
        }
        startIndex = lastIndex + 1;
      }

      const selectedDefinitions = projectionDefinitions
        .slice(startIndex, startIndex + request.input.pageSize);
      const definitions = selectedDefinitions.map((definition) => projectPublicDefinition(definition));
      const lastDefinition = selectedDefinitions.at(-1);
      const nextCursor = startIndex + selectedDefinitions.length < projectionDefinitions.length && lastDefinition
        ? encodePublicProjectionCursor({
          v: 1,
          scope,
          revision: snapshot.revision,
          lastDefinitionKeyDigest: publicProjectionDefinitionKeyDigest(lastDefinition),
        })
        : null;
      if (!await isCurrent(signal)) return { kind: 'unavailable' };
      return AutomationEventSourcesListResultV1Schema.parse({
        kind: 'page',
        revision: snapshot.revision,
        definitions,
        nextCursor,
      });
    },
    async prepareAdmission(request) {
      const signal = AbortSignal.any([params.generationSignal, request.signal ?? createEmptySignal()]);
      const input = AutomationEventAdmitInputV1Schema.safeParse(request.input);
      if (!input.success || !await isCurrent(signal)) return null;
      const admissionInput = input.data;
      const snapshot = await requireAdoptedSnapshot(signal);
      if (snapshot === null) return null;

      const selectorKeys = new Set(admissionInput.definitions.map(admissionKey));
      if (selectorKeys.size !== admissionInput.definitions.length) return null;
      const selectedDefinitions = admissionInput.definitions.map((selector) => {
        const selected = snapshot.definitionsByAdmissionKey.get(admissionKey(selector));
        return selected === undefined
          || !isExactAdoptedDefinitionForPreparation({
            definition: selected.definition,
            selector,
            eventRef: admissionInput.eventRef,
            caller: params.caller,
            transport: params.transport,
          })
          || selected.executionRecipe === null
          || selected.payloadValidator === null
          ? null
          : selected;
      });
      if (selectedDefinitions.some((definition) => definition === null)) return null;
      const selected = selectedDefinitions as AutomationEventAdoptedDefinitionSnapshotRecordV1[];
      const eventDeclarationRelease = snapshot.eventDeclarationRelease;
      if (selected.some((definition) => (
        definition.eventDeclarationRelease === null
        || !isSameAutomationEventDeclarationReleaseV1(
          eventDeclarationRelease,
          definition.eventDeclarationRelease,
        )
      ))) return null;

      const webhookInvocationReference = params.transport.kind === 'durablePush'
        ? readExactDurablePushInvocationReference({ selectedDefinitions: selected, caller: params.caller })
        : null;
      if (params.transport.kind === 'durablePush' && webhookInvocationReference === null) return null;

      // A fresh exact server witness for this admission request, admitted only
      // while it still names the Account content identity this snapshot's
      // definitions were adopted under.
      const accountEncryption = await readCurrentAccountEncryption(
        signal,
        snapshot.accountCurrentness,
      );
      if (accountEncryption === null) return null;

      if (accountEncryption.witness.mode === 'plain') {
        const initialAccountCurrentness = accountEncryption.witness;
        const hostEvidenceBase = {
          v: 1 as const,
          t: 'plain' as const,
          ...(webhookInvocationReference === null ? {} : { webhookInvocationReference }),
        };
        async function* preparePlainRequests(): AutomationEventAdmitPreparedRequestSequenceV1 {
          let definitionIndex = 0;
          let accountCurrentness = initialAccountCurrentness;
          while (definitionIndex < admissionInput.definitions.length) {
            signal.throwIfAborted();
            if (!await isCurrent(signal)) return;

            let requestToYield: AutomationEventAdmitHttpRequestV1 | null = null;
            let count = 0;
            while (
              definitionIndex + count < admissionInput.definitions.length
              && count < MAX_AUTOMATION_EVENT_ADMIT_DEFINITIONS_PER_CALL
            ) {
              const candidate = AutomationEventAdmitHttpRequestV1Schema.safeParse({
                v: 1,
                caller: request.caller,
                input: {
                  ...admissionInput,
                  definitions: admissionInput.definitions.slice(
                    definitionIndex,
                    definitionIndex + count + 1,
                  ),
                },
                hostEvidence: { ...hostEvidenceBase, accountCurrentness },
              });
              if (!candidate.success) break;
              requestToYield = candidate.data;
              count += 1;
            }
            // A single definition that cannot form a complete private request
            // leaves the remaining suffix unsafe; E2 owns its public result.
            if (requestToYield === null) return;
            signal.throwIfAborted();
            if (!await isCurrent(signal)) return;
            const successorAccountCurrentness = yield requestToYield;
            definitionIndex += count;
            // A following request is safe only after E2 returns the
            // server-owned successor from this request's ready continuation.
            if (definitionIndex >= admissionInput.definitions.length) return;
            if (
              successorAccountCurrentness === undefined
              || successorAccountCurrentness.mode !== 'plain'
              || successorAccountCurrentness.contentKeyFingerprint !== null
            ) return;
            accountCurrentness = {
              mode: 'plain',
              version: successorAccountCurrentness.version,
              contentKeyFingerprint: null,
            };
          }
        }
        return preparePlainRequests();
      }
      if (!isAvailableE2eeAutomationAccountEncryptionV1(accountEncryption)) return null;
      const accountMaterial = accountEncryption.material.material;

      try {
        const initialAccountCurrentness = accountEncryption.witness;
        const encryptedHostEvidenceBase = {
          v: 1,
          t: 'encrypted',
          adoptedRevision: snapshot.revision,
          eventRef: admissionInput.eventRef,
          eventDeclarationRelease,
          ...(webhookInvocationReference === null ? {} : { webhookInvocationReference }),
        } as const;
        const buildEncryptedDefinition = (
          selectedDefinition: AutomationEventAdoptedDefinitionSnapshotRecordV1,
        ): AutomationEventAdmitEncryptedDefinitionEvidenceV1 => {
          const definition = selectedDefinition.definition;
          const evidence = buildAutomationPluginEventOccurrenceEvidenceV1({
            eventRef: admissionInput.eventRef,
            sourceSelectorId: definition.sourceSelectorId,
            occurrenceId: admissionInput.occurrenceId,
            occurredAt: admissionInput.occurredAt,
            payload: admissionInput.payload,
          });
          const base = {
            automationId: definition.automationId,
            templateVersion: definition.templateVersion,
            sourceSelectorId: definition.sourceSelectorId,
            sourceContractVersion: definition.sourceContractVersion,
            observationTransport: definition.observationTransport.kind,
            occurrenceKey: deriveAutomationOccurrenceKeyV1(evidence),
            occurredAt: admissionInput.occurredAt,
            triggerEvidenceEnvelope: sealAutomationEventTriggerEvidenceEnvelopeV1({
              material: accountMaterial,
              evidence,
              randomBytes: request.randomBytes,
            }),
            occurrenceEvidenceEqualityTag: deriveAutomationEventTriggerEvidenceEqualityTagV1({
              material: accountMaterial,
              accountId: request.accountId,
              automationId: definition.automationId,
              evidence,
            }),
          };

          const observationStartsAt = definition.observationTransport.kind === 'durablePush'
            ? definition.observationTransport.observationStartsAt
            : null;
          if (
            observationStartsAt !== null
            && admissionInput.observationReceivedAt <= observationStartsAt
          ) {
            return { ...base, outcome: { kind: 'skipped', reason: 'beforeObservationStart' } };
          }
          if (!isAutomationEventObservationFreshV1({
            occurredAt: admissionInput.occurredAt,
            observationReceivedAt: admissionInput.observationReceivedAt,
            maximumObservationAgeMs: definition.maximumObservationAgeMs,
          })) {
            return { ...base, outcome: { kind: 'skipped', reason: 'outsideFreshness' } };
          }
          if (!isValidPluginJsonSchemaValue(selectedDefinition.payloadValidator!, admissionInput.payload)) {
            return { ...base, outcome: { kind: 'skipped', reason: 'occurrenceRejected' } };
          }
          if (!evaluateAutomationEventFilterV1(definition.filter, admissionInput.payload)) {
            return { ...base, outcome: { kind: 'skipped', reason: 'filtered' } };
          }

          const triggerEvidence = sealAutomationRunPluginEventTriggerEvidenceEnvelopeV1({
            material: accountMaterial,
            randomBytes: request.randomBytes,
            evidence: {
              ...evidence,
              sourceInstanceId: definition.sourceInstanceId,
              sourceContractVersion: definition.sourceContractVersion,
              observationReceivedAt: admissionInput.observationReceivedAt,
              filter: {
                version: definition.filter?.v ?? null,
                result: 'matched',
              },
            },
          });
          const executionRecipe = freezeAutomationRunPluginEventExecutionRecipeV1({
            definitionRecipe: selectedDefinition.executionRecipe,
            templateVersion: definition.templateVersion,
            triggerEvidence,
          });
          if (executionRecipe.kind !== 'available') throw new Error('execution_recipe_invalid');
          return {
            ...base,
            outcome: {
              kind: 'matched',
              executionRecipe: executionRecipe.serialized,
            },
          };
        };
        async function* prepareEncryptedRequests(): AutomationEventAdmitPreparedRequestSequenceV1 {
          let definitionIndex = 0;
          let carriedEvidence: AutomationEventAdmitEncryptedDefinitionEvidenceV1 | null = null;
          let accountCurrentness = initialAccountCurrentness;
          while (definitionIndex < selected.length || carriedEvidence !== null) {
            signal.throwIfAborted();
            if (!await isCurrent(signal)) return;

            const definitions: AutomationEventAdmitEncryptedDefinitionEvidenceV1[] = [];
            let requestToYield: AutomationEventAdmitHttpRequestV1 | null = null;
            while (definitions.length < MAX_AUTOMATION_EVENT_ADMIT_DEFINITIONS_PER_CALL) {
              const evidence: AutomationEventAdmitEncryptedDefinitionEvidenceV1 | null = carriedEvidence ?? (() => {
                if (definitionIndex >= selected.length) return null;
                const next = buildEncryptedDefinition(selected[definitionIndex]!);
                definitionIndex += 1;
                return next;
              })();
              if (evidence === null) break;

              const candidateRequest = {
                v: 1,
                caller: request.caller,
                hostEvidence: {
                  ...encryptedHostEvidenceBase,
                  accountCurrentness,
                  definitions: [...definitions, evidence],
                },
              };
              const candidateBytes = readAutomationEventAdmitHttpRequestCanonicalUtf8ByteLengthV1(
                candidateRequest,
              );
              if (candidateBytes > MAX_AUTOMATION_EVENT_ADMIT_HTTP_REQUEST_UTF8_BYTES) {
                if (definitions.length === 0) return;
                carriedEvidence = evidence;
                break;
              }
              const parsed = AutomationEventAdmitHttpRequestV1Schema.safeParse(candidateRequest);
              if (!parsed.success) return;
              definitions.push(evidence);
              carriedEvidence = null;
              requestToYield = parsed.data;
            }
            if (requestToYield === null) return;
            signal.throwIfAborted();
            if (!await isCurrent(signal)) return;
            const successorAccountCurrentness = yield requestToYield;
            // Do not let iterator advancement substitute for the server's
            // successor witness; preserve the frozen E2EE key identity too.
            if (definitionIndex >= selected.length && carriedEvidence === null) return;
            if (
              successorAccountCurrentness === undefined
              || successorAccountCurrentness.mode !== 'e2ee'
              || successorAccountCurrentness.contentKeyFingerprint
                !== initialAccountCurrentness.contentKeyFingerprint
            ) return;
            accountCurrentness = {
              mode: 'e2ee',
              version: successorAccountCurrentness.version,
              contentKeyFingerprint: initialAccountCurrentness.contentKeyFingerprint,
            };
          }
        }
        return prepareEncryptedRequests();
      } catch {
        return null;
      }
    },
  };
  return Object.freeze(definitionSet);
}
