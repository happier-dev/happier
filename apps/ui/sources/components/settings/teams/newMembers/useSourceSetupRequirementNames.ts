import * as React from 'react';
import { SourceSetupRequirementsV1Schema } from '@happier-dev/protocol/projects/projectSetupChangeV1';
import { PROJECT_SOURCE_SETUP_REQUIREMENTS_ACTION_ID_V1 } from '@happier-dev/protocol/actions/specs/projectSourcesActionIdsV1';
import type { ProjectSourceListItemV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';

import { useProjectSourceActionExecute } from '@/components/projects/sources/useProjectSources';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export type SourceSetupRequirementRead =
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'ready'; names: readonly string[] }>
  | Readonly<{ status: 'failed' }>;

type Entry = Readonly<{ revision: number; read: SourceSetupRequirementRead }>;
const LOADING: SourceSetupRequirementRead = Object.freeze({
  status: 'loading',
});
const FAILED: SourceSetupRequirementRead = Object.freeze({ status: 'failed' });

/**
 * The env requirement names each listed Source's published setup declares, read through the Source owner's
 * `projects.sources.setupRequirements` Action: one read per Source shown, again only when that Source's revision
 * changes or after a failed read. Names only; no manifest is parsed here and no value is ever returned.
 */
export function useSourceSetupRequirementNames(
  scope: ServerAccountScope,
  sources: readonly Pick<ProjectSourceListItemV1, 'id' | 'revision'>[],
  enabled: boolean,
) {
  const execute = useProjectSourceActionExecute();
  const [entries, setEntries] = React.useState<ReadonlyMap<string, Entry>>(
    () => new Map(),
  );
  const [attempt, setAttempt] = React.useState(0);
  const known = React.useRef<Map<string, Entry>>(new Map());
  const requests = React.useRef<AbortController | null>(null);
  const { serverId, accountId } = scope;

  // A new Account scope owns new reads; the previous scope's answers are never shown under it.
  React.useEffect(() => {
    const request = new AbortController();
    known.current = new Map();
    setEntries(new Map());
    requests.current = request;
    return () => request.abort();
  }, [serverId, accountId]);

  React.useEffect(() => {
    const request = requests.current;
    if (!enabled || !request) return;
    const due = sources.filter((source) => {
      const entry = known.current.get(source.id);
      return (
        !entry ||
        entry.revision !== source.revision ||
        entry.read.status === 'failed'
      );
    });
    if (due.length === 0) return;
    const settle = (
      source: (typeof due)[number],
      read: SourceSetupRequirementRead,
    ) => {
      if (request.signal.aborted) return;
      const current = known.current.get(source.id);
      // A newer revision's read already replaced this one.
      if (current && current.revision !== source.revision) return;
      known.current.set(source.id, { revision: source.revision, read });
      setEntries(new Map(known.current));
    };
    for (const source of due) {
      known.current.set(source.id, {
        revision: source.revision,
        read: LOADING,
      });
      void execute(
        PROJECT_SOURCE_SETUP_REQUIREMENTS_ACTION_ID_V1,
        { serverId, sourceId: source.id },
        {
          surface: 'ui',
          serverId,
          expectedAccountId: accountId,
          signal: request.signal,
        },
      ).then(
        (outcome) => {
          const parsed = outcome.ok
            ? SourceSetupRequirementsV1Schema.safeParse(outcome.result)
            : null;
          settle(
            source,
            !parsed?.success
              ? FAILED
              : {
                  status: 'ready',
                  names:
                    parsed.data.kind === 'published' ? parsed.data.names : [],
                },
          );
        },
        () => settle(source, FAILED),
      );
    }
    setEntries(new Map(known.current));
  }, [enabled, execute, serverId, accountId, sources, attempt]);

  const retry = React.useCallback(() => setAttempt((value) => value + 1), []);
  return { entries, retry };
}
