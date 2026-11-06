import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import type { WorkflowReferenceScope, WorkflowValueReference } from '@happier-dev/protocol/workflows/workflowReferenceV1';
import { findWorkflowBlock } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { parsePermissionIntentAlias } from '@happier-dev/agents/permissions';
import type { WorkflowResultField, WorkflowResultFieldType, WorkflowResultListItemType } from '@happier-dev/protocol/workflows/workflowResultFieldsV1';
import { WorkflowLoopOutcomeV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';
import { t } from '@/text';
import { en } from '@/text/translations/en';

export type WorkflowValuePresentationContext = Pick<WorkflowDefinitionV1, 'blocks'>;

/** The same human field name reads an Action row, a child input and a reference. */
export function formatWorkflowFieldLabel(name: string, title?: string): string {
    if (Object.hasOwn(en.workflows.page.fields, name)) {
        return t(`workflows.page.fields.${name as keyof typeof en.workflows.page.fields}`);
    }
    // An extension's declared title is presentation metadata; preserve it.
    // Undeclared bindings still need a readable label while staying repairable.
    const label = (title ?? name).replace(/\s*\((?:json|string|number|boolean|object|array)\)\s*$/iu, '').trim()
        .replace(/([a-z\d])([A-Z])/gu, '$1 $2').replace(/[_\-.]+/gu, ' ');
    return label.length === 0 ? t('workflows.input.label') : label[0]!.toLocaleUpperCase() + label.slice(1);
}

export function formatWorkflowReferenceScopeLabel(scope: WorkflowReferenceScope): string {
    if (scope.kind === 'outer') return t('workflows.input.scopeOuter', { levels: scope.levels });
    if (scope.kind === 'previous_iteration') return t('workflows.input.scopePreviousIteration');
    return t('workflows.input.scopeCurrent');
}

/**
 * A reference read as words ("Workflow input files", "Check the build result ·
 * verdict", "Item value"): the one reading Step options sentences, container
 * headings and condition summaries share, so a reference is never worded two
 * ways.
 */
export function formatWorkflowValueReference(draft: WorkflowValuePresentationContext, reference: WorkflowValueReference, fieldName?: string): string {
    const blockLabel = (blockId: string) => {
        const block = findWorkflowBlock(draft, blockId);
        return block === null ? t('workflows.contentUnavailable') : workflowBlockReferenceLabel(block);
    };
    const withPath = (label: string, path: readonly (string | number)[] | undefined) => (
        path === undefined || path.length === 0 ? label : `${label} · ${path.map(part => typeof part === 'number' ? String(part) : formatWorkflowFieldLabel(part)).join(' · ')}`
    );
    // A step's name already names one step, so a result read from an enclosing list reads as that
    // step ("Gather changes · Issues", lab E1); only the previous round is another value of it. The
    // producer select still says each scope (its option subtitles), where the choice is made.
    const producerLabel = (producer: Readonly<{ blockId: string; scope: WorkflowReferenceScope }>) => (
        producer.scope.kind === 'previous_iteration' ? `${blockLabel(producer.blockId)} · ${formatWorkflowReferenceScopeLabel(producer.scope)}` : blockLabel(producer.blockId)
    );
    switch (reference.kind) {
        case 'literal':
            // Only a declared Action field gives a literal execution meaning.
            // An arbitrary authored string or object must keep its own value.
            if (fieldName === 'target' && reference.value !== null && typeof reference.value === 'object'
                && !Array.isArray(reference.value) && Object.keys(reference.value).length === 1
                && Reflect.get(reference.value, 'kind') === 'detached') return t('workflows.page.sections.aBackgroundRun');
            if (fieldName === 'permissionMode' && typeof reference.value === 'string') {
                const mode = parsePermissionIntentAlias(reference.value);
                if (mode === 'read-only') return t('executionRuns.newRun.permissionModes.readOnly');
                if (mode === 'default') return t('executionRuns.newRun.permissionModes.default');
            }
            return formatWorkflowLiteralValue(reference.value);
        case 'input':
            return withPath(t('workflows.input.workflowInput', { name: formatWorkflowFieldLabel(reference.name) }), reference.path);
        case 'result':
            // A field reads as its step and field ("Check the fix · Fixed", lab E1); the whole result keeps its noun.
            return reference.path.length === 0
                ? t('workflows.input.previousResult', { block: producerLabel(reference.producer) })
                : withPath(producerLabel(reference.producer), reference.path);
        case 'loop_trailing_count':
            return t('workflows.input.trailingCount', {
                source: withPath(t('workflows.input.previousResult', { block: producerLabel(reference.producer) }), reference.path),
                value: formatWorkflowLiteralValue(reference.equals),
            });
        case 'workspace':
            return `${t('workflows.workspace.title')} · ${producerLabel(reference.producer)} · ${t(reference.field === 'directory' ? 'workflows.workspace.projectCheckout' : 'workflows.input.checkoutRoot')}`;
        case 'item':
            return withPath(t(`workflows.input.itemField.${reference.field}`), reference.path);
        case 'iteration':
            return t(`workflows.input.iterationField.${reference.field}`);
        case 'session_context':
            return t('workflows.input.sessionContext', { turns: reference.recentTurns });
        case 'session_context_field':
            return reference.field === 'usage.tokensUsed' ? t('workflows.input.tokensUsed') : t('workflows.input.goalTokenBudget');
        default:
            return t('workflows.input.unavailableValue');
    }
}

/** Literal data is readable too; typed loop outcomes never leak their wire objects. */
function formatWorkflowLiteralValue(value: JsonValue): string {
    const outcome = WorkflowLoopOutcomeV1Schema.safeParse(value);
    if (outcome.success) {
        switch (outcome.data.kind) {
            case 'stop_condition': return outcome.data.arm === undefined ? t('workflows.input.stopCondition')
                : t('workflows.input.stopConditionArm', { arm: outcome.data.arm + 1 });
            case 'exhausted': return t('workflows.input.roundLimit', { rounds: outcome.data.rounds });
            case 'decision': return `${t('workflows.input.decision')} · ${outcome.data.value}${outcome.data.reason ? ` · ${outcome.data.reason}` : ''}`;
        }
    }
    if (typeof value === 'string') return `“${value}”`;
    if (typeof value === 'boolean') return t(value ? 'common.yes' : 'common.no');
    if (value === null) return t('workflows.page.inspector.none');
    if (typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.length === 0 ? t('workflows.page.inspector.none') : value.map(formatWorkflowLiteralValue).join(', ');
    const entries = Object.entries(value);
    return entries.length === 0 ? t('workflows.page.inspector.none')
        : entries.map(([name, nested]) => `${formatWorkflowFieldLabel(name)}: ${formatWorkflowLiteralValue(nested)}`).join('; ');
}

export const WORKFLOW_RESULT_FIELD_TYPE_LABEL_KEY = {
  boolean: 'typeBoolean',
  text: 'typeText',
  number: 'typeNumber',
  choice: 'typeChoice',
  list: 'typeList',
} as const satisfies Record<WorkflowResultFieldType, string>;
const ITEMS_LABEL_KEY = {
  text: 'itemsText',
  number: 'itemsNumber',
  boolean: 'itemsBoolean',
} as const satisfies Record<WorkflowResultListItemType, string>;

export function workflowResultFieldText(key: string, params?: Record<string, string | number>): string {
  // The key is chosen at runtime from one known group; `t`'s per-key parameter typing cannot follow it.
  const translate = t as unknown as (key: string, params?: Record<string, string | number>) => string;
  return translate(`workflows.page.inspector.resultFields.${key}`, params);
}

/** "Yes/No", "Choice", "List of text": the type a field returns, in words. */
export function formatWorkflowResultFieldType(
  field: WorkflowResultField,
): string {
  return field.type === 'list'
    ? workflowResultFieldText('listOf', { items: workflowResultFieldText(ITEMS_LABEL_KEY[field.itemType ?? 'text']) })
    : workflowResultFieldText(WORKFLOW_RESULT_FIELD_TYPE_LABEL_KEY[field.type]);
}
