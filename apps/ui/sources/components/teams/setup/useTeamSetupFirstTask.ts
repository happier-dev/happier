import * as React from 'react';
import {
  resolveProjectSourceOnboardingTaskV1,
  type ProjectSourceOnboardingTaskSelectionV1,
} from '@happier-dev/protocol/projects/sources/projectSourceOnboardingTaskV1';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';

/**
 * The Team's suggested first task (plan D1/M1), read only once setup is done and the page is about to show it.
 * The Source names the prompt; the ordinary prompt reader owns access and decryption.
 */
export function useTeamSetupFirstTask(
  input: Readonly<{
    serverId: string;
    sources: readonly ProjectSourceV1[];
    enabled: boolean;
  }>,
): ProjectSourceOnboardingTaskSelectionV1['task'] {
  const { serverId, sources, enabled } = input;
  const [task, setTask] =
    React.useState<ProjectSourceOnboardingTaskSelectionV1['task']>(null);
  const key = enabled
    ? JSON.stringify([
        serverId,
        sources.map((source) => [source.id, source.revision]),
      ])
    : null;
  const sourcesRef = React.useRef(sources);
  sourcesRef.current = sources;
  React.useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    void resolveProjectSourceOnboardingTaskV1({
      sources: sourcesRef.current.map((source) => ({ serverId, source })),
      signal: controller.signal,
      readPrompt: async (ref, options) => {
        try {
          const [
            { readPromptDocInLibrary },
            { withUiPromptLibraryArtifactStore },
          ] = await Promise.all([
            import('@happier-dev/protocol/prompts/library/promptLibraryActionOperations'),
            import('@/sync/ops/promptLibrary/promptLibraryArtifactStore'),
          ]);
          return await withUiPromptLibraryArtifactStore(
            (store) =>
              readPromptDocInLibrary({
                store,
                artifactId: ref.artifactId,
                ...(options?.signal ? { signal: options.signal } : {}),
              }),
            {
              serverId: ref.serverId,
              ...(options?.signal ? { signal: options.signal } : {}),
            },
          );
        } catch (error) {
          options?.signal?.throwIfAborted();
          const code =
            error instanceof Error &&
            'code' in error &&
            typeof error.code === 'string'
              ? error.code
              : 'content_unavailable';
          return { ok: false as const, errorCode: code, error: code };
        }
      },
    }).then(
      (selection) => {
        if (!controller.signal.aborted) setTask(selection.task);
      },
      () => {},
    );
    return () => controller.abort();
  }, [key, serverId]);
  return key ? task : null;
}
