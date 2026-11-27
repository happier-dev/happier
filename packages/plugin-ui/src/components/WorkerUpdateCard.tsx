import type { ReactElement, ReactNode } from 'react';

import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';

/** One Execution Run: the Session that hosts it and the Run in that Session (a Task's `runLink`). */
export type WorkerUpdateCardRunV1 = Readonly<{
  sessionId: string;
  runId: string;
}>;

export type WorkerUpdateCardProps = Readonly<{
  /** The Run whose retained report the card shows, in the mounting surface's Account. */
  run: WorkerUpdateCardRunV1;
  testID?: string;
  /**
   * Shown while the host has no report for this Run (not finished, not read on this device, or a host without
   * Happier's report card, such as an isolated web frame). Keep your own short account of the work here.
   */
  fallback?: ReactNode;
}>;

/**
 * The agent's report for one Run, drawn by Happier's own report card: the agent's face, state, result, checks,
 * the pull request, screenshots, preview, deviations and next step. Bodies stay closed until the person opens
 * them, and every read and open goes through the host; your plugin receives none of the report's content.
 *
 * ```tsx
 * <WorkerUpdateCard run={task.runLink} fallback={<Text value={task.report} />} />
 * ```
 */
export function WorkerUpdateCard({
  fallback,
  ...input
}: WorkerUpdateCardProps): ReactElement {
  return (
    <>
      {useOptionalPluginUiPresentationHost()?.renderWorkerUpdateCard?.({
        ...input,
        fallback,
      }) ?? fallback}
    </>
  );
}
