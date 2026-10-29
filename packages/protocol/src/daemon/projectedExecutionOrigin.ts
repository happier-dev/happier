import type { z } from 'zod/mini';
import { getPluginMachineExecutionOriginRef, type PluginMachineExecutionOriginV1 } from '../machines/administration/pluginMachineExecutionOriginV1.js';
import { pluginSourceCustodyV1Equal, type PluginSourceCustodyV1 } from '../plugins/runtime/sourceCustody.js';

/** Every projected declaration retains the same supplying plugin and custody. */
export function validateProjectedExecutionOrigin(
  executionOrigin: PluginMachineExecutionOriginV1 | undefined,
  producer: Readonly<{ pluginId: string; sourceCustody?: PluginSourceCustodyV1 }>,
  context: z.core.$RefinementCtx,
): void {
  if (!executionOrigin) return;
  const refKind = 'sourceRef' in executionOrigin ? 'sourceRef' : 'materializationRef';
  if (getPluginMachineExecutionOriginRef(executionOrigin).pluginId !== producer.pluginId) {
    context.addIssue({ code: 'custom', path: ['executionOrigin', refKind, 'pluginId'],
      message: 'Projected execution origin must match its producer pluginId.' });
  }
  if ('sourceRef' in executionOrigin && producer.sourceCustody
    && !pluginSourceCustodyV1Equal(executionOrigin.sourceRef.sourceCustody, producer.sourceCustody)) {
    context.addIssue({ code: 'custom', path: ['executionOrigin', 'sourceRef', 'sourceCustody'],
      message: 'Projected source execution origin must match its producer source custody.' });
  }
}
