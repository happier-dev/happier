import { createStoredReadSchema } from '../json/storedReadSchema.js';

import {
  isAvailableE2eeAutomationAccountEncryptionV1,
  type AvailableAutomationAccountEncryptionV1,
} from './automationAccountCurrentnessV1.js';
import type { AutomationDefinitionDisplayV1 } from './automationDefinitionDisplayV1.js';
import {
  AutomationEventTriggerDefinitionStoredPayloadV1Schema,
} from './automationEventV1.js';
import {
  openAutomationStoredWorkflowDefinitionV2,
} from './automationWorkflowRecipeV2.js';
import {
  openAutomationStoredActionDefinitionTemplateV1,
} from './automationRunExecutionRecipeV1.js';
import {
  AutomationTriggerDefinitionBindingV1Schema,
  openAutomationTriggerDefinitionStoredEnvelopeV1,
} from './automationTriggerDefinitionStoredContent.js';

type AutomationDisplayEventTriggerV1 = Readonly<{
  id: string;
  revision: number;
  kind: string;
  eventRef?: Readonly<{ pluginId: string; localId: string }>;
  sourceSelectorId?: string;
  triggerDefinitionEnvelope?: string | null;
}>;

/** The list and detail projections share this narrow opaque-display carrier. */
export type AutomationDefinitionDisplayCarrierV1 = Readonly<{
  id: string;
  name: string;
  description: string | null;
  observationOnly?: unknown;
  executionRecipe?: unknown;
  triggers: readonly AutomationDisplayEventTriggerV1[];
}>;

export type AutomationDefinitionDisplayReadResultV1 =
  | Readonly<{
      kind: 'available';
      /** `legacy` is the retained raw-row compatibility path, never a new writer. */
      source: 'workflowDefinition' | 'actionDefinition' | 'eventDefinition' | 'legacy';
      display: AutomationDefinitionDisplayV1;
    }>
  | Readonly<{ kind: 'contentInvalid' | 'modeMismatch' | 'bindingMismatch' }>;

function legacyDisplay(definition: AutomationDefinitionDisplayCarrierV1): AutomationDefinitionDisplayReadResultV1 {
  return {
    kind: 'available',
    source: 'legacy',
    display: { name: definition.name, description: definition.description },
  };
}

function sameDisplay(
  left: AutomationDefinitionDisplayV1,
  right: AutomationDefinitionDisplayV1,
): boolean {
  return left.name === right.name && left.description === right.description;
}

/**
 * Opens an existing private definition carrier for display only. New labels
 * have no public fallback: raw row fields are accepted solely when a retained
 * carrier predates the display field.
 */
export function readAutomationDefinitionDisplayV1(params: Readonly<{
  definition: AutomationDefinitionDisplayCarrierV1;
  encryption: AvailableAutomationAccountEncryptionV1;
}>): AutomationDefinitionDisplayReadResultV1 {
  const recipe = params.definition.executionRecipe;
  if (recipe !== null && typeof recipe === 'object' && 'v' in recipe && recipe.v === 2 && 'workflow' in recipe) {
    const opened = openAutomationStoredWorkflowDefinitionV2({ workflow: recipe.workflow, encryption: params.encryption });
    if (opened.kind !== 'available') return opened;
    return opened.definition.display === undefined
      ? legacyDisplay(params.definition)
      : { kind: 'available', source: 'workflowDefinition', display: opened.definition.display };
  }

  if (recipe !== null && typeof recipe === 'object' && 'v' in recipe && recipe.v === 1 && 'template' in recipe) {
    const opened = openAutomationStoredActionDefinitionTemplateV1({ template: recipe.template, encryption: params.encryption });
    if (opened.kind !== 'available') return opened;
    return opened.template.display === undefined
      ? legacyDisplay(params.definition)
      : { kind: 'available', source: 'actionDefinition', display: opened.template.display };
  }

  // Observation-only definitions own their existing private Event payloads.
  // An executable predecessor may also contain Event triggers, but its label
  // remains in the Workflow/legacy definition carrier rather than those source
  // envelopes.
  if (params.definition.observationOnly === undefined) return legacyDisplay(params.definition);
  let display: AutomationDefinitionDisplayV1 | undefined;
  for (const trigger of params.definition.triggers) {
    if (trigger.kind !== 'pluginEvent' || !trigger.eventRef || !trigger.sourceSelectorId
      || typeof trigger.triggerDefinitionEnvelope !== 'string') continue;
    let envelope: unknown;
    try {
      envelope = JSON.parse(trigger.triggerDefinitionEnvelope);
    } catch {
      return { kind: 'contentInvalid' };
    }
    const binding = AutomationTriggerDefinitionBindingV1Schema.safeParse({
      v: 1,
      automationId: params.definition.id,
      triggerId: trigger.id,
      triggerRevision: trigger.revision,
      triggerKind: 'pluginEvent',
      eventRef: trigger.eventRef,
      sourceSelectorId: trigger.sourceSelectorId,
    });
    if (!binding.success) return { kind: 'contentInvalid' };
    const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({
      binding: binding.data,
      envelope,
      ...(isAvailableE2eeAutomationAccountEncryptionV1(params.encryption)
        ? { mode: 'e2ee' as const, material: params.encryption.material.material }
        : { mode: 'plain' as const }),
    });
    if (opened.kind === 'materialUnavailable') return { kind: 'contentInvalid' };
    if (opened.kind !== 'available') return opened;
    const definition = createStoredReadSchema(AutomationEventTriggerDefinitionStoredPayloadV1Schema)
      .safeParse(opened.definition);
    if (!definition.success) return { kind: 'contentInvalid' };
    if (definition.data.automationDisplay === undefined) continue;
    if (display !== undefined && !sameDisplay(display, definition.data.automationDisplay)) {
      return { kind: 'contentInvalid' };
    }
    display = definition.data.automationDisplay;
  }
  return display === undefined
    ? legacyDisplay(params.definition)
    : { kind: 'available', source: 'eventDefinition', display };
}

/** Avoids resolving Account material for released raw-row list items. */
export function hasPrivateAutomationDefinitionDisplayCarrierV1(
  definition: AutomationDefinitionDisplayCarrierV1,
): boolean {
  const recipe = definition.executionRecipe;
  if (recipe !== null && typeof recipe === 'object' && 'v' in recipe
    && (recipe.v === 1 || recipe.v === 2)) return true;
  return definition.observationOnly !== undefined && definition.triggers.some(trigger =>
    trigger.kind === 'pluginEvent' && typeof trigger.triggerDefinitionEnvelope === 'string');
}
