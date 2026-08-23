import { isPluginError, PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginActionInputById, PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import { QualifiedConnectedAccountRefJsonSchema } from '@happier-dev/plugin-sdk/connected-accounts';
import {
  PluginEventAutomationSetupResultV1Schema,
  type PluginEventAutomationSetupResultV1,
} from '@happier-dev/plugin-sdk/events';

import {
  TELEGRAM_AUTOMATION_MESSAGE_EVENT_ID,
  TELEGRAM_AUTOMATION_MESSAGE_SOURCE_CONTRACT_VERSION,
} from './constants.js';
import type { TelegramBotIdentity, TelegramUpdate } from './telegramBotApi.js';

/**
 * Telegram Automation Event admission — retained implementation for a WITHHELD
 * declaration. `plugin.ts` declares no Event, so nothing can arm a Telegram
 * chat source and this module admits nothing today.
 *
 * It is deliberately NOT called from the live poll. The host builds an
 * adopted-definition owner only for a manifest-declared automation-eligible
 * Event, so while this Event is withheld every `automation.event.sources.list`
 * fails with `automation_event_adopted_definitions_unavailable` — once per
 * observed batch, on every Machine, forever. The Discord provider already
 * withdraws its own call sites for the same reason
 * (`discordGatewaySupervisor.ts`, `discordAutomationEvent.ts`); this module
 * follows that same canonical treatment rather than adding a second one.
 *
 * To resume: re-add the `events` entry to `plugin.ts` using the ids and schemas
 * exported here, then restore the one call site `pollTelegramObservations`
 * gives up while the Event is withheld — `admitTelegramAutomationOccurrences`
 * over the observed batch, before the shared `getUpdates` offset advances.
 *
 * What a future lane must build before the Event is declared: make the
 * occurrence a DURABLE OBLIGATION in the SAME ingress store the canonical
 * Channels owner already uses (`packages/plugins/channels/src/ingress.ts`:
 * `retryDueIngressObligationValue`, `blockedIngressObligationValue`,
 * `MAX_CONVERSATION_DELIVERY_ATTEMPTS`, and the `unsettled`/`checkpointSafe`
 * result it returns to the checkpoint owner), persisted BEFORE the shared
 * `getUpdates` offset advances — one shared single-consumer lifecycle. No
 * second `getUpdates` consumer, no provider-local replay ledger, no new store.
 */

/**
 * The persisted source facts. The bot is identified by its immutable Telegram
 * id rather than by a credential reference, because the observing poll already
 * holds the exact authenticated bot identity for the Channel connection it is
 * running. Nothing here is a credential.
 */
export const TELEGRAM_AUTOMATION_MESSAGE_SOURCE_CONFIG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    v: { type: 'integer', const: 1 },
    botId: { type: 'string', minLength: 1, maxLength: 64 },
    chatId: { type: 'string', minLength: 1, maxLength: 64 },
  },
  required: ['v', 'botId', 'chatId'],
} as const satisfies PluginJsonSchema;

export const TELEGRAM_AUTOMATION_MESSAGE_PAYLOAD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    chatId: { type: 'string', minLength: 1, maxLength: 64 },
    chatType: { type: 'string', enum: ['private', 'group', 'supergroup', 'channel'] },
    messageId: { type: 'string', minLength: 1, maxLength: 64 },
    text: { type: 'string', maxLength: 8192 },
    senderId: { type: 'string', maxLength: 64 },
    senderIsBot: { type: 'boolean' },
  },
  required: ['chatId', 'chatType', 'messageId', 'text', 'senderIsBot'],
} as const satisfies PluginJsonSchema;

export const TELEGRAM_AUTOMATION_MESSAGE_SETUP_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    credentialRef: QualifiedConnectedAccountRefJsonSchema,
    chatId: { type: 'string', minLength: 1, maxLength: 64 },
  },
  required: ['credentialRef', 'chatId'],
} as const satisfies PluginJsonSchema;

export const TELEGRAM_AUTOMATION_MESSAGE_SETUP_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    v: { type: 'integer', const: 1 },
    sourceInstanceId: { type: 'string', minLength: 1, maxLength: 512 },
    sourceContractVersion: {
      type: 'integer',
      const: TELEGRAM_AUTOMATION_MESSAGE_SOURCE_CONTRACT_VERSION,
    },
    sourceConfig: TELEGRAM_AUTOMATION_MESSAGE_SOURCE_CONFIG_SCHEMA,
    displayLabel: { type: 'string', minLength: 1, maxLength: 256 },
  },
  required: ['v', 'sourceInstanceId', 'sourceContractVersion', 'sourceConfig', 'displayLabel'],
} as const satisfies PluginJsonSchema;

type TelegramAutomationSourceConfig = Readonly<{ botId: string; chatId: string }>;

function readSourceConfig(value: unknown): TelegramAutomationSourceConfig | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const botId = record.botId;
  const chatId = record.chatId;
  if (record.v !== 1 || typeof botId !== 'string' || typeof chatId !== 'string') return null;
  if (botId.length === 0 || chatId.length === 0) return null;
  return { botId, chatId };
}

export function buildTelegramAutomationSourceInstanceId(input: TelegramAutomationSourceConfig): string {
  return `telegram:chat:${input.botId}:${input.chatId}`;
}

/**
 * Resolves the operator-entered chat into the immutable source facts the
 * canonical Automation definition writer persists. It owns no Automation
 * state and performs no observation.
 */
export async function buildTelegramChatEventSourceSetupResult(input: Readonly<{
  botId: string;
  chatId: string;
  label: string | null;
}>): Promise<PluginEventAutomationSetupResultV1> {
  const sourceConfig = Object.freeze({ v: 1 as const, botId: input.botId, chatId: input.chatId });
  return PluginEventAutomationSetupResultV1Schema.parse({
    v: 1,
    sourceInstanceId: buildTelegramAutomationSourceInstanceId(sourceConfig),
    sourceContractVersion: TELEGRAM_AUTOMATION_MESSAGE_SOURCE_CONTRACT_VERSION,
    sourceConfig,
    displayLabel: input.label?.trim() || `Chat ${input.chatId}`,
  });
}

type SourcesListResult = PluginActionResultById['automation.event.sources.list'];
type AdmitInput = PluginActionInputById['automation.event.admit'];
type AdmitDefinitionSelector = AdmitInput['definitions'][number];

/**
 * One armed Telegram Automation Event source, reduced to the facts the poll
 * needs to match an observed update.
 */
type ArmedTelegramSource = Readonly<{
  chatId: string;
  selector: AdmitDefinitionSelector;
}>;

/**
 * What this poll knows about the armed Telegram sources.
 *
 * `absent` is the one outcome that proves no Telegram source can be armed here,
 * so the batch is consumable with nothing lost. `unknown` means the armed set
 * could not be read coherently; the shared single-consumer offset must then be
 * withheld rather than discarding occurrences that were never evaluated.
 */
type ArmedTelegramSourcesRead =
  | Readonly<{ kind: 'armed'; sources: readonly ArmedTelegramSource[] }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'unknown' }>;

const ARMED_SOURCES_UNKNOWN: ArmedTelegramSourcesRead = Object.freeze({ kind: 'unknown' });

function readCatalogUnavailability(
  context: PluginInvocationContext,
  error: unknown,
): ArmedTelegramSourcesRead {
  if (context.signal.aborted) throw error;
  // `unsupported_action` is the host stating it has no Automation Event
  // producer at all, so this Machine cannot hold an armed Telegram source.
  const kind = isPluginError(error) && error.code === 'unsupported_action'
    ? 'absent' as const
    : 'unknown' as const;
  context.services.logger.warn('telegram_automation_event.sources_unavailable', {
    outcome: kind,
    reason: error instanceof Error ? error.message : 'unknown',
  });
  return kind === 'absent' ? Object.freeze({ kind }) : ARMED_SOURCES_UNKNOWN;
}

async function readArmedTelegramSources(input: Readonly<{
  context: PluginInvocationContext;
  botId: string;
}>): Promise<ArmedTelegramSourcesRead> {
  const armed: ArmedTelegramSource[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let revision: string | null = null;
  // The cursor chain is exhausted, never truncated. A page ceiling would drop
  // every definition past it and then let the shared single-consumer offset
  // advance, silently losing those Automations' occurrences. The chain is
  // already bounded by the Account's enabled-source ceiling, by the repeated-
  // cursor guard below, by the mid-scan revision check, and by this poll's
  // abort signal.
  for (;;) {
    input.context.signal.throwIfAborted();
    const request: PluginActionInputById['automation.event.sources.list'] = {
      transport: { kind: 'checkpointedPull' },
      ...(cursor === undefined ? {} : { cursor }),
    };
    let result: SourcesListResult;
    try {
      result = await input.context.services.actions.execute(
        'automation.event.sources.list',
        request,
        { signal: input.context.signal },
      );
    } catch (error) {
      // The Automation catalog is a separate authority from the Channel. Its
      // failure must never fail this poll: the Channels ingress records a
      // failing provider poll Action as a blocked connection on the first
      // attempt, which would stop Channel delivery entirely.
      return readCatalogUnavailability(input.context, error);
    }
    input.context.signal.throwIfAborted();
    // A revision move mid-scan means the armed set is no longer one coherent
    // catalog. Admit nothing rather than admitting a torn read.
    if (result.kind !== 'page' || (revision !== null && result.revision !== revision)) {
      return ARMED_SOURCES_UNKNOWN;
    }
    revision ??= result.revision;
    for (const definition of result.definitions) {
      if (definition.eventRef.localId !== TELEGRAM_AUTOMATION_MESSAGE_EVENT_ID) continue;
      if (definition.sourceContractVersion !== TELEGRAM_AUTOMATION_MESSAGE_SOURCE_CONTRACT_VERSION) continue;
      if (definition.observationTransport.kind !== 'checkpointedPull') continue;
      const config = readSourceConfig(definition.sourceConfig);
      if (config === null || config.botId !== input.botId) continue;
      armed.push({
        chatId: config.chatId,
        selector: {
          automationId: definition.automationId,
          templateVersion: definition.templateVersion,
          sourceSelectorId: definition.sourceSelectorId,
        },
      });
    }
    if (result.nextCursor === null) return Object.freeze({ kind: 'armed' as const, sources: armed });
    if (seenCursors.has(result.nextCursor)) return ARMED_SOURCES_UNKNOWN;
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
}

export type TelegramAutomationAdmissionOutcome = Readonly<{
  /**
   * The first update whose occurrence could not be admitted checkpoint-safely.
   * The shared Telegram checkpoint must not advance past it, because the same
   * `offset` also confirms the Channels ingress observations.
   */
  stopBeforeUpdateId: string | null;
  admittedCount: number;
}>;

const NO_ADMISSION: TelegramAutomationAdmissionOutcome = Object.freeze({
  stopBeforeUpdateId: null,
  admittedCount: 0,
});

/**
 * Admits Automation Event occurrences for the updates the Channels ingress
 * poll already observed. This is deliberately not a second observer: Telegram
 * `getUpdates` is single-consumer, so the one existing poll is the only place
 * an occurrence can be observed without discarding Channel messages.
 */
export async function admitTelegramAutomationOccurrences(input: Readonly<{
  context: PluginInvocationContext;
  identity: TelegramBotIdentity;
  updates: readonly TelegramUpdate[];
  observationReceivedAt: number;
}>): Promise<TelegramAutomationAdmissionOutcome> {
  // The Channels ingress already refuses edits as non-admissible content, so
  // an Automation must not make a second, different decision about them: a new
  // occurrence per edit would also re-run the same Automation. This bot's own
  // messages are excluded because an Automation that replies would retrigger
  // itself.
  const candidates = input.updates.filter((update) => (
    update.kind === 'message'
    && update.message !== null
    && update.message.senderId !== input.identity.id
  ));
  if (candidates.length === 0) return NO_ADMISSION;
  const read = await readArmedTelegramSources({
    context: input.context,
    botId: input.identity.id,
  });
  // Admission is a strictly additive consumer of the Channels ingress, exactly
  // as the Discord provider already contracts it. The Automation catalog is a
  // separate authority whose unavailability is unbounded and invisible to the
  // Channel, so it must never withhold the shared single-consumer offset: doing
  // that stops Channel delivery for every user of this bot, including one who
  // holds no Automation at all, until the checkpoint ages out into a history
  // gap. A missed occurrence during that outage is the bounded cost.
  if (read.kind === 'unknown') {
    // The batch is consumed anyway (see above), so this is the one place the
    // loss becomes observable. `absent` proves nothing could be armed and is
    // not a loss; `unknown` means occurrences were never evaluated.
    input.context.services.logger.warn('telegram_automation_event.occurrences_unevaluated', {
      candidateCount: candidates.length,
    });
    return NO_ADMISSION;
  }
  if (read.kind !== 'armed' || read.sources.length === 0) return NO_ADMISSION;
  const armed = read.sources;

  let admittedCount = 0;
  for (const update of candidates) {
    const message = update.message!;
    const definitions = armed
      .filter((source) => source.chatId === message.chatId)
      .map((source) => source.selector);
    if (definitions.length === 0) continue;
    input.context.signal.throwIfAborted();
    const admitInput: AdmitInput = {
      eventRef: {
        pluginId: input.context.plugin.id,
        localId: TELEGRAM_AUTOMATION_MESSAGE_EVENT_ID,
      },
      occurrenceId: `telegram:update:${update.updateId}`,
      occurredAt: message.sentAtMs,
      observationReceivedAt: input.observationReceivedAt,
      payload: {
        chatId: message.chatId,
        chatType: message.chatType,
        messageId: message.messageId,
        text: message.text ?? '',
        ...(message.senderId === null ? {} : { senderId: message.senderId }),
        senderIsBot: message.senderIsBot,
      },
      definitions,
    };
    let admitted: PluginActionResultById['automation.event.admit'];
    try {
      admitted = await input.context.services.actions.execute(
        'automation.event.admit',
        admitInput,
        { signal: input.context.signal },
      );
    } catch (error) {
      if (input.context.signal.aborted) throw error;
      // An unreachable admission host is the same separate-authority outage as
      // an unreadable catalog: it cannot be allowed to hold the Channel's
      // offset. Stop admitting for this batch and let the Channel consume it.
      input.context.services.logger.warn('telegram_automation_event.admission_failed', {
        occurrenceId: admitInput.occurrenceId,
        reason: error instanceof Error ? error.message : 'unknown',
      });
      return { stopBeforeUpdateId: null, admittedCount };
    }
    input.context.signal.throwIfAborted();
    if (!admitted.results.every((result) => result.checkpointSafe)) {
      return { stopBeforeUpdateId: update.updateId, admittedCount };
    }
    admittedCount += 1;
  }
  return { stopBeforeUpdateId: null, admittedCount };
}

export function throwTelegramAutomationSetupInvalid(): never {
  throw new PluginError({
    code: 'telegram_automation_source_input_invalid',
    message: 'The Telegram Automation Event source input is invalid.',
  });
}
