import type { PluginTranslate } from '@happier-dev/plugin-ui';
import type { TriageTaskWriteResultV1 } from '@happier-dev/triage-protocol/v1';

export type TaskWriteMessageContext = Readonly<{ sourceName?: string; operation: 'create' | 'edit'; target?: string | null }>;

/** One presentation for task writes, including releases outside a React translation scope. */
export function taskWriteMessage(text: PluginTranslate, result: TriageTaskWriteResultV1,
  context?: TaskWriteMessageContext): string {
  if (result.kind === 'uncertain' && context?.sourceName !== undefined) {
    if (context.target != null) return text('plugins.triage.tasks.write.uncertainMove',
      '{source} may have moved this task to {target}. Check it before moving it again.', { source: context.sourceName, target: context.target });
    return context.operation === 'create' ? text('plugins.triage.tasks.write.uncertainCreate',
      '{source} may have created this task. Check it before creating another.', { source: context.sourceName })
      : text('plugins.triage.tasks.write.uncertainEdit',
        '{source} may have saved your changes. Check it before saving again.', { source: context.sourceName });
  }
  return text(`plugins.triage.tasks.write.${result.kind}`, result.kind === 'applied' ? 'Saved at the source'
    : result.kind === 'uncertain' ? 'The source may have saved this. Check it before creating or saving again.'
      : result.kind === 'refused' ? 'This change is not available for this task.' : 'The source could not save this change.');
}
