import type { WorkflowBlock, WorkflowDefinitionV1, WorkflowStep } from '@happier-dev/protocol/workflows/workflowV1';
import { getBuiltinWorkflowCatalogV1 } from '@happier-dev/protocol/workflows';
import { listActionSpecs } from '@happier-dev/protocol/actions/actionSpecs';
import { t } from '@/text';
import { resolveWorkflowActionTitle } from './workflowActionPresentation';

/** Document headings and reference tokens share human names; ids stay in bindings only. */
export function workflowBlockReferenceLabel(block: WorkflowBlock, fallbackLabel?: string): string {
  const authoredName = block.name?.trim();
  if (authoredName) return authoredName;
  if (fallbackLabel !== undefined) return fallbackLabel;
  switch (block.kind) {
    case 'step': return t('workflows.editor.addStep');
    case 'wait': return t('workflows.page.blocks.waitTitle');
    case 'action': return resolveWorkflowActionTitle(block.actionId, listActionSpecs().find(spec => spec.id === block.actionId) ?? null);
    case 'workflow': {
      const builtin = getBuiltinWorkflowCatalogV1().find(entry => entry.id === block.workflowRef);
      return builtin === undefined ? t('workflows.page.blocks.menuRun') : t(builtin.titleKey as never);
    }
    case 'parallel': return t('workflows.editor.addParallel');
    case 'if': return t('workflows.editor.addIf');
    case 'loop': return block.repetition.kind === 'items' ? t('workflows.loop.modeItems')
      : block.repetition.kind === 'until' ? t('workflows.loop.modeUntil') : t('workflows.editor.addLoop');
  }
}

function workflowStepFirstPromptLine(step: WorkflowStep): string | null {
  return step.document.text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? null;
}

function firstWorkflowStep(blocks: readonly WorkflowBlock[]): WorkflowStep | null {
  for (const block of blocks) {
    if (block.kind === 'step') return block;
    if (block.kind === 'parallel') {
      for (const branch of block.branches) {
        const step = firstWorkflowStep(branch.blocks);
        if (step !== null) return step;
      }
      continue;
    }
    if (block.kind === 'if') {
      const step = firstWorkflowStep(block.then) ?? firstWorkflowStep(block.otherwise);
      if (step !== null) return step;
      continue;
    }
    // An Action call, a nested workflow and a Wait for you carry no agent prompt.
    if (block.kind === 'action' || block.kind === 'workflow' || block.kind === 'wait') continue;
    const bodyStep = firstWorkflowStep(block.body);
    if (bodyStep !== null) return bodyStep;
    if (block.repetition.kind === 'evaluate' && block.repetition.evaluator.kind === 'step') {
      return block.repetition.evaluator;
    }
  }
  return null;
}

/**
 * Default private title for saving a frozen Run as a new Artifact. The title
 * comes only from opened authored prompt content and is not derived from a
 * public summary, result preview, transcript, or opaque Run id.
 */
export function workflowDefinitionPromptTitle(definition: WorkflowDefinitionV1): string | null {
  const step = firstWorkflowStep(definition.blocks);
  return step === null ? null : workflowStepFirstPromptLine(step);
}
