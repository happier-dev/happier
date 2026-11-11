import { throwIfAborted } from '@happier-dev/plugin-sdk/async';
import { bindCorpusCollections } from '../corpus/collections/bindCorpusCollections.js';
import { readActiveConfiguredSourceRows } from '../corpus/configuration/readConfiguredSourceRows.js';
import { renderSourceQualifiedId } from '../corpus/identity/components.js';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../targetedContributions.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';
import type { TriageDataActionHandler } from './dataContext.js';
import { indexTriageAdmittedSourcesV1 } from './listEntries.js';
import type { TriageResolveResourceActionInputV1, TriageResolveResourceActionResultV1 } from './resolveResourceProtocol.js';

/** One finite walk of configured connections; only the source can mint entry identity. */
export function createTriageResolveResourceActionHandler(): TriageDataActionHandler<
  TriageResolveResourceActionInputV1,
  TriageResolveResourceActionResultV1
> {
  return async (input, context) => {
    throwIfAborted(context.signal);
    const options = { signal: context.signal };
    const { sourceInstances } = bindCorpusCollections(requireTriageAccountStorage(context));
    const observation = context.services.targetedContributions.observeForSelf(
      TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1, { onInvalidated: () => {} },
    );
    try {
      const [configured, admitted] = await Promise.all([
        readActiveConfiguredSourceRows(sourceInstances, options),
        observation.readCurrent(options),
      ]);
      const sources = indexTriageAdmittedSourcesV1(admitted.contributions);
      for (const row of configured.rows) {
        throwIfAborted(context.signal);
        const instance = row.configured;
        const operation = sources.get(renderSourceQualifiedId(instance.instance.source))?.operations.resolveResource;
        if (operation === undefined) continue;
        try {
          const result = await context.services.actions.executeAdmittedTargetedOperation(operation,
            { v: 1, instance, resource: input.resource }, options);
          throwIfAborted(context.signal);
          if (result.kind === 'resolved') return {
            kind: 'resolved', sourceInstance: instance.instance,
            entryRef: { source: instance.instance.source, ...result.localRef },
            locator: result.locator,
          };
        } catch {
          throwIfAborted(context.signal);
          // Another configured connection may read the URL. Provider failures
          // settle this connection; the walk never retries it.
        }
      }
      throwIfAborted(context.signal);
      return { kind: 'unavailable' };
    } finally {
      observation.dispose();
    }
  };
}
