import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { StructuredQuestionAnswersV1 } from '@happier-dev/protocol';

import { requireLoadedAcpSdk } from '@/agent/acp/connection/acpSdk';
import {
  defineAcpExtensionRequest,
  type AcpExtensionHandlerContext,
  type AcpExtensionRegistration,
} from '@/agent/acp/connection/types';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import {
  InvalidAskUserQuestionInputError,
  normalizeAskUserQuestionInputForPublication,
} from '@/agent/questions/normalizeAskUserQuestionInput';
import { logger } from '@/ui/logger';

/**
 * ACP `elicitation/create` (form mode) projected onto Happier's canonical AskUserQuestion owner.
 *
 * The ACP form schema is a flat object of primitive properties. Each answerable property becomes
 * one structured question; the reply maps the answered labels back to the schema's values.
 * Only clients that pass `formElicitation` advertise `clientCapabilities.elicitation.form`.
 */
export const ACP_ELICITATION_CREATE_METHOD = 'elicitation/create';

const BOOLEAN_TRUE_LABEL = 'Yes';
const BOOLEAN_FALSE_LABEL = 'No';
/**
 * Free-text companion field conventions: `<key>__other` (MCP form producers) or `<key>_other`
 * (agy 1.5.18 `ask_question` forms: `q1` oneOf + optional `q1_other` string) next to a choice field
 * `<key>` is offered as that question's own free-form answer instead of a separate question.
 */
const FREEFORM_COMPANION_SUFFIXES = ['__other', '_other'] as const;

type ElicitationContentValue = string | boolean | readonly string[];

type ChoiceOption = Readonly<{ label: string; value: string | boolean }>;

type QuestionBinding = Readonly<{
  key: string;
  questionText: string;
  kind: 'single' | 'multi' | 'text';
  options: readonly ChoiceOption[];
  /** Field receiving a free-form answer to a choice question. */
  freeformKey?: string;
  required: boolean;
}>;

export type AcpFormElicitationProjection = Readonly<{
  sessionId: string;
  toolCallId: string | null;
  askUserQuestionInput: Readonly<{ questions: ReadonlyArray<Record<string, unknown>> }>;
  bindings: readonly QuestionBinding[];
}>;

export class AcpFormElicitationUnsupportedError extends Error {
  readonly name = 'AcpFormElicitationUnsupportedError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonBlank(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function unsupported(message: string): never {
  throw new AcpFormElicitationUnsupportedError(message);
}

function readTitledOptions(raw: unknown): ChoiceOption[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.map((entry) => {
    if (!isRecord(entry) || typeof entry.const !== 'string') unsupported('Elicitation option is not a titled string constant');
    return { label: readNonBlank(entry.title) ?? entry.const, value: entry.const };
  });
}

function readEnumOptions(raw: unknown): ChoiceOption[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.map((entry) => {
    if (typeof entry !== 'string') unsupported('Elicitation enum value is not a string');
    return { label: entry, value: entry };
  });
}

function readStringChoices(property: Record<string, unknown>): ChoiceOption[] | null {
  return readTitledOptions(property.oneOf) ?? readEnumOptions(property.enum);
}

function readArrayChoices(property: Record<string, unknown>): ChoiceOption[] {
  const items = isRecord(property.items) ? property.items : unsupported('Multi-select elicitation field has no items');
  const options = readTitledOptions(items.anyOf) ?? readEnumOptions(items.enum);
  if (!options) unsupported('Multi-select elicitation field has no enumerated items');
  return options;
}

function isPlainTextProperty(property: unknown): property is Record<string, unknown> {
  return isRecord(property) && property.type === 'string' && readStringChoices(property) === null;
}

export function projectAcpFormElicitation(
  params: Record<string, unknown>,
  boundSessionId: string | null,
): AcpFormElicitationProjection {
  if (params.mode !== 'form') unsupported(`Unsupported elicitation mode: ${String(params.mode)}`);
  const sessionId = readNonBlank(params.sessionId);
  if (!sessionId || sessionId !== boundSessionId) unsupported('Elicitation is not scoped to the bound ACP session');
  const schema = isRecord(params.requestedSchema) ? params.requestedSchema : unsupported('Elicitation has no requested schema');
  const properties = isRecord(schema.properties) ? schema.properties : unsupported('Elicitation schema has no properties');
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : []);
  const header = readNonBlank(schema.title) ?? 'Question';

  const companionKeyByOwner = new Map<string, string>();
  for (const key of Object.keys(properties)) {
    const suffix = FREEFORM_COMPANION_SUFFIXES.find((candidate) => key.endsWith(candidate));
    if (!suffix || !isPlainTextProperty(properties[key])) continue;
    const ownerKey = key.slice(0, -suffix.length);
    const owner = properties[ownerKey];
    if (!companionKeyByOwner.has(ownerKey) && isRecord(owner) && (owner.type === 'array' || (owner.type === 'string' && readStringChoices(owner)))) {
      companionKeyByOwner.set(ownerKey, key);
    }
  }
  const companionKeys = new Set(companionKeyByOwner.values());

  const bindings: QuestionBinding[] = [];
  const questions: Array<Record<string, unknown>> = [];
  for (const [key, rawProperty] of Object.entries(properties)) {
    if (companionKeys.has(key)) continue;
    if (!isRecord(rawProperty)) unsupported(`Elicitation field ${key} is not a schema object`);
    const questionText = readNonBlank(rawProperty.title) ?? readNonBlank(rawProperty.description) ?? key;
    const freeformKey = companionKeyByOwner.get(key);
    const freeformProperty = freeformKey ? properties[freeformKey] as Record<string, unknown> : undefined;
    let binding: QuestionBinding;
    if (rawProperty.type === 'string') {
      const choices = readStringChoices(rawProperty);
      binding = choices
        ? { key, questionText, kind: 'single', options: choices, freeformKey, required: required.has(key) }
        : { key, questionText, kind: 'text', options: [], required: required.has(key) };
    } else if (rawProperty.type === 'array') {
      binding = { key, questionText, kind: 'multi', options: readArrayChoices(rawProperty), freeformKey, required: required.has(key) };
    } else if (rawProperty.type === 'boolean') {
      binding = {
        key,
        questionText,
        kind: 'single',
        options: [{ label: BOOLEAN_TRUE_LABEL, value: true }, { label: BOOLEAN_FALSE_LABEL, value: false }],
        required: required.has(key),
      };
    } else {
      unsupported(`Elicitation field ${key} has unsupported type ${String(rawProperty.type)}`);
    }
    bindings.push(binding);

    const description = readNonBlank(rawProperty.description);
    questions.push({
      id: key,
      header,
      question: questionText,
      multiSelect: binding.kind === 'multi',
      options: binding.options.map((option) => ({ label: option.label, description: option.label })),
      ...(binding.kind === 'text'
        ? { freeform: { ...(description && description !== questionText ? { description } : {}), allowEmpty: !binding.required } }
        : freeformProperty
          ? { freeform: { placeholder: readNonBlank(freeformProperty.title) ?? 'Other', ...(readNonBlank(freeformProperty.description) ? { description: freeformProperty.description } : {}) } }
          : {}),
    });
  }
  if (questions.length === 0) unsupported('Elicitation form has no answerable fields');

  const askUserQuestionInput = { questions };
  try {
    normalizeAskUserQuestionInputForPublication('AskUserQuestion', askUserQuestionInput);
  } catch (error) {
    if (error instanceof InvalidAskUserQuestionInputError) unsupported('Elicitation form cannot be presented as structured questions');
    throw error;
  }
  return {
    sessionId,
    toolCallId: readNonBlank(params.toolCallId),
    askUserQuestionInput,
    bindings,
  };
}

/** Maps validated structured answers back onto the elicitation's requested schema. */
export function buildAcpFormElicitationContent(
  projection: AcpFormElicitationProjection,
  answers: StructuredQuestionAnswersV1,
): Record<string, ElicitationContentValue> {
  const content: Record<string, ElicitationContentValue> = {};
  for (const binding of projection.bindings) {
    const values = answers[binding.key] ?? answers[binding.questionText];
    if (!values || values.length === 0) continue;
    if (binding.kind === 'text') {
      const text = values[0] ?? '';
      if (text.length > 0) content[binding.key] = text;
      continue;
    }
    const byLabel = new Map(binding.options.map((option) => [option.label, option.value] as const));
    const selected = values.filter((value) => byLabel.has(value)).map((value) => byLabel.get(value)!);
    const freeform = values.filter((value) => !byLabel.has(value));
    if (binding.kind === 'multi') {
      if (selected.length > 0) content[binding.key] = selected.map(String);
    } else if (selected.length > 0) {
      content[binding.key] = selected[0]!;
    }
    if (freeform.length > 0) {
      if (!binding.freeformKey) {
        throw new Error(`Elicitation answer for ${binding.key} is not one of its options`);
      }
      content[binding.freeformKey] = freeform.join(', ');
    }
  }
  return content;
}

type PermissionDecision = Awaited<ReturnType<AcpPermissionHandler['handleToolCall']>> & {
  answers?: StructuredQuestionAnswersV1;
};

function awaitDecision(
  decision: Promise<PermissionDecision>,
  context: AcpExtensionHandlerContext,
): Promise<PermissionDecision | 'aborted'> {
  if (context.signal.aborted) return Promise.resolve('aborted');
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve('aborted');
    context.signal.addEventListener('abort', onAbort, { once: true });
    decision.then(resolve, reject).finally(() => context.signal.removeEventListener('abort', onAbort));
  });
}

function isApproved(decision: string): boolean {
  return decision === 'approved'
    || decision === 'approved_for_session'
    || decision === 'approved_execpolicy_amendment';
}

/** Registers the ACP form elicitation request against the session's structured question owner. */
export function buildAcpFormElicitationRegistration(
  permissionHandler: AcpPermissionHandler,
): AcpExtensionRegistration {
  return defineAcpExtensionRequest({
    method: ACP_ELICITATION_CREATE_METHOD,
    params: z.record(z.string(), z.unknown()),
    handler: async (params, context): Promise<Record<string, unknown>> => {
      let projection: AcpFormElicitationProjection;
      try {
        projection = projectAcpFormElicitation(params, context.sessionId);
      } catch (error) {
        if (error instanceof AcpFormElicitationUnsupportedError) {
          logger.warn(`[ACP] Rejected ${context.agentName} elicitation: ${error.message}`);
          throw requireLoadedAcpSdk().RequestError.invalidParams({ details: error.message });
        }
        throw error;
      }
      const toolCallId = projection.toolCallId ?? `acp-elicitation-${randomUUID()}`;
      if (projection.toolCallId) {
        context.toolCalls?.enrich(projection.toolCallId, {
          toolName: 'AskUserQuestion',
          rawInput: projection.askUserQuestionInput,
        });
      }
      const decision = await awaitDecision(
        permissionHandler.handleToolCall(toolCallId, 'AskUserQuestion', projection.askUserQuestionInput) as Promise<PermissionDecision>,
        context,
      );
      if (decision === 'aborted' || decision.decision === 'abort') return { action: 'cancel' };
      if (!isApproved(decision.decision)) return { action: 'decline' };
      if (!decision.answers) {
        throw new Error('Approved elicitation decision did not include structured answers');
      }
      return { action: 'accept', content: buildAcpFormElicitationContent(projection, decision.answers) };
    },
  });
}
