import * as React from 'react';
import { readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionErrorClassV1';
import {
  resolveProjectSourceOnboardingTaskV1,
  type ProjectSourceOnboardingTaskSelectionV1,
} from '@happier-dev/protocol/projects/sources/projectSourceOnboardingTaskV1';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { PromptDocReadResultV1Schema } from '@happier-dev/protocol/prompts/library/promptDocV2';

import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';

import type { TeamSetupActionContext } from './teamSetupPlan';

/**
 * The Team's suggested first task (plan D1/M1), read only once setup is done and the page is about to show it.
 * The Source names the prompt. The ordinary prompt Action handles policy, access and decryption.
 */
export function useTeamSetupFirstTask(
  input: Readonly<{
    execute: FrontDoorActionExecute;
    context: TeamSetupActionContext;
    sources: readonly ProjectSourceV1[];
    enabled: boolean;
  }>,
): ProjectSourceOnboardingTaskSelectionV1['task'] {
  const { execute, context, sources, enabled } = input;
  const { serverId, expectedAccountId } = context;
  const [selection, setSelection] = React.useState<{
    key: string;
    task: ProjectSourceOnboardingTaskSelectionV1['task'];
  } | null>(null);
  const key = enabled
    ? JSON.stringify([
        serverId,
        expectedAccountId,
        sources.map((source) => [source.id, source.revision]),
      ])
    : null;
  const sourcesRef = React.useRef(sources);
  sourcesRef.current = sources;
  React.useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    const { signal, dispose } = mergeAbortSignals([controller.signal, context.signal]);
    void resolveProjectSourceOnboardingTaskV1({
      sources: sourcesRef.current.map((source) => ({ serverId, source })),
      signal,
      readPrompt: async (ref) => {
        try {
          const result = await execute('prompt_doc.get', { artifactId: ref.artifactId }, {
            surface: context.surface,
            serverId: ref.serverId,
            ...(areServerProfileIdentifiersEquivalent(serverId, ref.serverId) ? { expectedAccountId } : {}),
            signal,
          });
          if (!result.ok) return result;
          const document = PromptDocReadResultV1Schema.safeParse(result.result);
          return document.success
            ? document.data
            : { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
        } catch (error) {
          signal.throwIfAborted();
          const code = readActionErrorCodeV1(error) ?? 'content_unavailable';
          return { ok: false, errorCode: code, error: code };
        }
      },
    }).then(
      (selection) => {
        if (!signal.aborted) setSelection({ key, task: selection.task });
      },
      () => {},
    );
    return () => {
      controller.abort();
      dispose();
    };
  }, [context, execute, expectedAccountId, key, serverId]);
  return selection?.key === key ? selection.task : null;
}
