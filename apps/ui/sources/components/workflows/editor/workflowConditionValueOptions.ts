import type { WorkflowValueReference } from '@happier-dev/protocol/workflows/workflowReferenceV1';
import { findWorkflowBlock } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { listWorkflowBlockOrdinalsV1 } from '@happier-dev/protocol/workflows/workflowStepLabel';
import {
  projectWorkflowResultFields,
  type WorkflowResultField,
} from '@happier-dev/protocol/workflows/workflowResultFieldsV1';
import type { WorkflowResultContract } from '@happier-dev/protocol/workflows/workflowV1';

import { listWorkflowProducerOptions, resolveWorkflowReferenceScopeFacts, type WorkflowReferenceConsumer } from '@/sync/domains/workflows/workflowAuthoring';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { t } from '@/text';

import type { WorkflowConditionValueFacts } from '../presentation/workflowConditionRules';
import { formatWorkflowFieldLabel, formatWorkflowReferenceScopeLabel, formatWorkflowResultFieldType, workflowResultFieldText } from '../presentation/workflowValuePresentation';

export type WorkflowConditionValueOption = Readonly<{
  id: string;
  title: string;
  category: string;
  /** The value's type in words, on the option's right. */
  typeLabel: string | null;
  reference: WorkflowValueReference;
  facts: WorkflowConditionValueFacts;
  /** Choosing it opens the path field beside the picker, for a value nothing declares. */
  opensPath?: boolean;
}>;

const UNKNOWN: WorkflowConditionValueFacts = { type: 'unknown' };
const TEXT: WorkflowConditionValueFacts = { type: 'text' };
const NUMBER: WorkflowConditionValueFacts = { type: 'number' };

function factsForField(
  field: WorkflowResultField,
): WorkflowConditionValueFacts {
  return field.type === 'choice'
    ? { type: 'choice', choices: field.choices ?? [] }
    : { type: field.type };
}

/** What a whole result is, from its contract: a step with no contract returns text. */
function factsForWholeResult(
  result: WorkflowResultContract | undefined,
): WorkflowConditionValueFacts {
  if (result === undefined || result.kind === 'text') return TEXT;
  if (result.kind === 'decision')
    return { type: 'choice', choices: result.decisions };
  return UNKNOWN;
}

function resultContractOf(
  draft: WorkflowEditorDraft,
  blockId: string,
): WorkflowResultContract | undefined | null {
  const block = findWorkflowBlock(draft, blockId);
  return block !== null && (block.kind === 'step' || block.kind === 'wait')
    ? block.result
    : null;
}

/**
 * The value's type, as far as the authored definition says it. A value nothing types (a child
 * workflow's result, a loop's item) is `unknown`, and every test stays available for it.
 */
export function resolveWorkflowConditionValueFacts(
  draft: WorkflowEditorDraft,
  reference: WorkflowValueReference,
): WorkflowConditionValueFacts {
  switch (reference.kind) {
    case 'literal':
      return typeof reference.value === 'boolean'
        ? { type: 'boolean' }
        : typeof reference.value === 'number'
          ? NUMBER
          : typeof reference.value === 'string'
            ? TEXT
            : UNKNOWN;
    case 'input': {
      if (reference.path !== undefined && reference.path.length > 0)
        return UNKNOWN;
      const input = draft.inputs.find(
        (candidate) => candidate.name === reference.name,
      );
      if (input === undefined) return UNKNOWN;
      if (input.enum !== undefined)
        return {
          type: 'choice',
          choices: input.enum.filter(
            (value): value is string => typeof value === 'string',
          ),
        };
      return input.valueType === 'boolean'
        ? { type: 'boolean' }
        : input.valueType === 'number'
          ? NUMBER
          : input.valueType === 'string'
            ? TEXT
            : UNKNOWN;
    }
    case 'result': {
      const contract = resultContractOf(draft, reference.producer.blockId);
      if (contract === null) return UNKNOWN;
      if (reference.path.length === 0) return factsForWholeResult(contract);
      const projection = projectWorkflowResultFields(contract);
      const field =
        reference.path.length === 1 && projection.kind === 'fields'
          ? projection.fields.find(
              (candidate) => candidate.name === reference.path[0],
            )
          : undefined;
      return field === undefined ? UNKNOWN : factsForField(field);
    }
    case 'workspace':
      return TEXT;
    case 'iteration':
      return reference.field === 'stopReason' ? TEXT : NUMBER;
    case 'item':
      return reference.field === 'value' ? UNKNOWN : NUMBER;
    default:
      return UNKNOWN;
  }
}

function typeLabelFor(facts: WorkflowConditionValueFacts): string | null {
  switch (facts.type) {
    case 'boolean':
      return t('workflows.page.inspector.resultFields.typeBoolean');
    case 'number':
      return t('workflows.page.inspector.resultFields.typeNumber');
    case 'text':
      return t('workflows.page.inspector.resultFields.typeText');
    case 'choice':
      return t('workflows.page.inspector.resultFields.typeChoice');
    case 'list':
      return t('workflows.page.inspector.resultFields.typeList');
    case 'unknown':
      return null;
  }
}

const ITEM_FIELDS = ['value', 'index', 'position', 'count'] as const;
const ITERATION_FIELDS = ['index', 'position', 'count', 'stopReason'] as const;

/**
 * Every value this block can test, one list grouped by where it comes from. The reference's kind,
 * producer and field are this list's concern; the person only ever picks a value by name.
 */
export function listWorkflowConditionValueOptions(
  draft: WorkflowEditorDraft,
  consumerBlockId: string,
  consumer?: WorkflowReferenceConsumer,
): readonly WorkflowConditionValueOption[] {
  const options: WorkflowConditionValueOption[] = [];
  const push = (
    category: string,
    title: string,
    reference: WorkflowValueReference,
    typeLabelOverride?: string,
  ): void => {
    const facts = resolveWorkflowConditionValueFacts(draft, reference);
    options.push({
      id: JSON.stringify(reference),
      title,
      category,
      reference,
      facts,
      typeLabel: typeLabelOverride ?? typeLabelFor(facts),
    });
  };
  const producers = listWorkflowProducerOptions(
    draft,
    consumerBlockId,
    consumer,
  );
  // Two blocks can share a label ("Agent step"): the number the document shows them under tells them apart.
  const ordinals = listWorkflowBlockOrdinalsV1(draft.blocks);
  const blocksByLabel = new Map<string, Set<string>>();
  for (const producer of producers) {
    blocksByLabel.set(producer.label, (blocksByLabel.get(producer.label) ?? new Set()).add(producer.blockId));
  }
  const distinctLabel = (producer: (typeof producers)[number]): string => {
    const ordinal = ordinals.get(producer.blockId);
    return (blocksByLabel.get(producer.label)?.size ?? 0) > 1 && ordinal !== undefined && ordinal !== null
      ? `${ordinal} · ${producer.label}` : producer.label;
  };
  for (const producer of producers) {
    const label = producer.isBranch
      ? formatWorkflowFieldLabel(producer.label)
      : distinctLabel(producer);
    const category =
      producer.scope.kind === 'previous_iteration'
        ? `${label} · ${formatWorkflowReferenceScopeLabel(producer.scope)}`
        : label;
    const source = { blockId: producer.blockId, scope: producer.scope };
    const contract = producer.isBranch
      ? null
      : resultContractOf(draft, producer.blockId);
    const projection =
      contract === null ? null : projectWorkflowResultFields(contract);
    const declaresFields = projection?.kind === 'fields' && projection.fields.length > 0;
    if (declaresFields) {
      for (const field of projection.fields) {
        push(
          category,
          field.title ?? formatWorkflowFieldLabel(field.name),
          { kind: 'result', producer: source, path: [field.name] },
          formatWorkflowResultFieldType(field),
        );
      }
    }
    const whole: WorkflowValueReference = { kind: 'result', producer: source, path: [] };
    push(category, t('workflows.condition.wholeResult'), whole);
    // A step's text has no inside; anything structured or untyped can be read into.
    if (contract === null || contract?.kind === 'json') {
      const facts = resolveWorkflowConditionValueFacts(draft, whole);
      options.push({ id: `${JSON.stringify(whole)}#path`, title: workflowResultFieldText('otherPath'), category, reference: whole, facts, typeLabel: null, opensPath: true });
    }
  }
  for (const input of draft.inputs) {
    push(
      t('workflows.condition.fromRun'),
      formatWorkflowFieldLabel(input.name),
      { kind: 'input', name: input.name },
    );
  }
  const scope = resolveWorkflowReferenceScopeFacts(
    draft,
    consumerBlockId,
    consumer,
  );
  if (scope.insideItemsLoop) {
    for (const field of ITEM_FIELDS)
      push(
        t('workflows.condition.thisItem'),
        t(`workflows.input.itemField.${field}`),
        { kind: 'item', field },
      );
  }
  if (scope.insideLoop) {
    for (const field of ITERATION_FIELDS)
      push(
        t('workflows.condition.thisRound'),
        t(`workflows.input.iterationField.${field}`),
        { kind: 'iteration', field },
      );
  }
  for (const producer of producers) {
    if (producer.isBranch || producer.scope.kind === 'previous_iteration')
      continue;
    const source = { blockId: producer.blockId, scope: producer.scope };
    push(
      t('workflows.condition.whereItWorks'),
      t('workflows.condition.folderOf', { step: distinctLabel(producer) }),
      { kind: 'workspace', producer: source, field: 'directory' },
    );
    push(
      t('workflows.condition.whereItWorks'),
      t('workflows.condition.projectFolderOf', { step: distinctLabel(producer) }),
      { kind: 'workspace', producer: source, field: 'checkoutRootPath' },
    );
  }
  return options;
}

/** Whether this reference is a field its producer declares, so no path entry is needed to reach it. */
export function workflowValueIsDeclaredField(draft: WorkflowEditorDraft, reference: Extract<WorkflowValueReference, { kind: 'result' | 'input' }>): boolean {
  if (reference.kind !== 'result' || reference.path.length !== 1) return false;
  const contract = resultContractOf(draft, reference.producer.blockId);
  const projection = contract === null ? null : projectWorkflowResultFields(contract);
  return projection?.kind === 'fields' && projection.fields.some((field) => field.name === reference.path[0]);
}
