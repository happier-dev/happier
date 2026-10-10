import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod';
import { isPluginDeclarativeDataNodeV1 } from '../../../plugins/contributions/ui/declarativeDataV1.js';
import { PluginDeclarativeDocumentV1Schema } from '../../../plugins/contributions/ui/declarativeDocumentAuthoringV1.js';
import { preflightPluginDeclarativeDocumentV1 } from '../../../plugins/contributions/ui/declarativeDocumentPreflightV1.js';
import type { PluginDeclarativeNodeV2 } from '../../../plugins/contributions/ui/v2.js';

/** Session content reuses the renderer grammar and its pre-recursion resource bounds. */
export const SessionSurfaceDeclarativeDocumentV1Schema = lazyZodSchema(() => z.unknown().superRefine((document, context) => {
  const result = preflightPluginDeclarativeDocumentV1(document);
  if (!result.ok) context.addIssue({ code: 'custom', message: result.message });
}).pipe(PluginDeclarativeDocumentV1Schema).superRefine((document, context) => {
  const pending: PluginDeclarativeNodeV2[] = [document.root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    // Plugin-owned bindings cannot acquire authority from a Session record.
    if ((isPluginDeclarativeDataNodeV1(node) && node.data.kind === 'resource')
      || node.kind === 'field' || node.kind === 'collectionList' || node.kind === 'targetedSurface'
      || node.kind === 'dragSource' || node.kind === 'dropTarget' || node.kind === 'widgetArea'
      || (node.kind === 'action' && node.hostAction === undefined)
      || (node.kind === 'item' && (node.action !== undefined || node.input !== undefined))) {
      context.addIssue({ code: 'custom', message: 'This declarative binding requires a producer-admitted host Action or installed plugin' });
    }
    if ('children' in node) pending.push(...node.children);
  }
}));
export type SessionSurfaceDeclarativeDocumentV1 = z.infer<typeof SessionSurfaceDeclarativeDocumentV1Schema>;
