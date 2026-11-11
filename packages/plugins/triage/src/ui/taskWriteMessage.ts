import type { PluginTranslate } from '@happier-dev/plugin-ui';
import type { TriageTaskWriteResultV1 } from '@happier-dev/triage-protocol/v1';

export type TaskWriteMessageContext = Readonly<{ sourceName?: string; operation: 'create' | 'edit'; target?: string | null }>;

/** UI-only metadata already supplied by a write's producer; never inferred from its code. */
export type TaskWritePresentationResult = TriageTaskWriteResultV1 & Readonly<{
  message?: string;
  requestId?: string;
  phase?: string;
  effectAttempted?: boolean;
}>;

/** One presentation for task writes, including releases outside a React translation scope. */
export function taskWriteMessage(text: PluginTranslate, result: TaskWritePresentationResult,
  context?: TaskWriteMessageContext): string {
  let headline: string;
  if (result.kind === 'uncertain' && context?.sourceName !== undefined) {
    if (context.target != null) headline = text('plugins.triage.tasks.write.uncertainMove',
      '{source} may have moved this task to {target}. Check it before moving it again.', { source: context.sourceName, target: context.target });
    else headline = context.operation === 'create' ? text('plugins.triage.tasks.write.uncertainCreate',
      '{source} may have created this task. Check it before creating another.', { source: context.sourceName })
      : text('plugins.triage.tasks.write.uncertainEdit',
        '{source} may have saved your changes. Check it before saving again.', { source: context.sourceName });
  } else {
    headline = text(`plugins.triage.tasks.write.${result.kind}`, result.kind === 'applied' ? 'Saved at the source'
      : result.kind === 'uncertain' ? 'The source may have saved this. Check it before creating or saving again.'
        : result.kind === 'refused' ? 'This change is not available for this task.' : 'The source could not save this change.');
  }
  return result.kind === 'applied' || result.message === undefined ? headline : `${headline} ${result.message}`;
}

export function taskSourceLinkLabel(text: PluginTranslate, sourceName?: string): string {
  return sourceName === undefined ? text('plugins.triage.tasks.write.openSource', 'Open source')
    : text('plugins.triage.tasks.write.openInSource', 'Open in {source}', { source: sourceName });
}
