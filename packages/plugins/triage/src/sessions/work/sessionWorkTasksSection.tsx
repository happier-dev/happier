import * as React from 'react';
import type { RenderSurface } from '@happier-dev/plugin-sdk/ui';
import {
  Item,
  ItemGroup,
  Icon,
  TaskStatusGlyph,
  defineUiSurface,
  usePluginHostApi,
  usePluginTranslation,
  useSurfaceContext,
} from '@happier-dev/plugin-ui';
import { triageTaskStatusCategoryV1 } from '@happier-dev/triage-protocol/v1';

import type { InternalTaskListProjection } from '../../internalTasks/listProjection.js';
import { isHostCancellation } from '../../hostCancellation.js';
import { triageEntryRowKey, type TriageListRowV1 } from '../../projection/listWindow.js';
import { presentTriageMountedUiActionFailure } from '../../ui/mountedActions.js';
import { openTriageLinkedEntry } from '../../ui/navigation/openLinkedEntry.js';
import { projectTriageEntryDisplay, readTriageEntryGlyphV1 } from '../../ui/window/entryDisplay.js';
import { useTriageListWindow } from '../../ui/window/useTriageListWindow.js';
import { useTriageListWindowViewDemand } from '../../ui/window/useTriageListWindowViewDemand.js';

const EMPTY_ROWS: readonly TriageListRowV1[] = Object.freeze([]);

/**
 * Pure projection of Tasks linked to or claimed/assigned to one exact Session.
 *
 * Reads only the already-projected Task list window (`rows` + `taskProjection`):
 * zero new pollers, zero N+1 reads, zero settings-blob writes.
 */
export function projectSessionWorkTasksV1(input: Readonly<{
  sessionId: string;
  rows: readonly TriageListRowV1[] | undefined;
  taskProjection: InternalTaskListProjection | undefined;
}>): readonly TriageListRowV1[] {
  const { sessionId, rows, taskProjection } = input;
  if (!sessionId || !rows || rows.length === 0 || !taskProjection) return EMPTY_ROWS;

  const matchedKeys = new Set<string>();
  for (const entry of taskProjection.entries) {
    const linked = entry.result.kind !== 'failed'
      && entry.result.links.some((link) => link.sessionId === sessionId);
    const claimed = entry.claim?.attemptBinding.sessionId === sessionId;
    if (linked || claimed) {
      matchedKeys.add(triageEntryRowKey(entry.entryRef));
    }
  }
  if (matchedKeys.size === 0) return EMPTY_ROWS;

  return rows.filter((row) => matchedKeys.has(triageEntryRowKey(row.entryRef)));
}

/**
 * Triage's `Work › Tasks` inline section inside `SessionWorkView` (`sessionWorkSection`).
 *
 * Reuses the one shared mounted Task list projection (`useTriageListWindow`) so it adds
 * zero new pollers, zero N+1 reads, and zero settings-blob writes. Renders nothing when
 * no Tasks are linked or assigned to the mounted Session.
 */
export function TriageSessionWorkTasksSection(): React.ReactElement | null {
  const text = usePluginTranslation();
  const hostApi = usePluginHostApi();
  const surfaceContext = useSurfaceContext();
  const sessionId = surfaceContext.target.kind === 'session' ? surfaceContext.target.sessionId : null;
  const window = useTriageListWindow();
  useTriageListWindowViewDemand(sessionId !== null, window.refresh, window.readiness, window.readOwner);

  const tasks = React.useMemo(
    () => (sessionId === null ? EMPTY_ROWS : projectSessionWorkTasksV1({
      sessionId,
      rows: window.snapshot.window?.rows,
      taskProjection: window.snapshot.taskProjection,
    })),
    [sessionId, window.snapshot.taskProjection, window.snapshot.window?.rows],
  );

  const openTask = React.useCallback((row: TriageListRowV1) => {
    void openTriageLinkedEntry(hostApi, row.entryRef).then((result) => {
      if (result.kind === 'refused' && result.reason === 'unavailable') {
        return presentTriageMountedUiActionFailure(hostApi, result.error, text);
      }
    }).catch((error: unknown) => {
      if (!isHostCancellation(error, undefined)) {
        return presentTriageMountedUiActionFailure(hostApi, error, text);
      }
    });
  }, [hostApi, text]);

  if (tasks.length === 0) return null;

  return (
    <ItemGroup
      testID="triage-session-work-tasks"
      title={text('plugins.triage.tasks.title', 'Tasks')}
    >
      {tasks.map((row) => {
        const display = projectTriageEntryDisplay(row, text);
        const state = row.content?.outcome.snapshot.state;
        const category = state === undefined ? null : triageTaskStatusCategoryV1(state);
        const subtitle = [display.lifecycleLabel, display.scopeLabel].filter(part => part?.trim()).join(' · ');
        return (
          <Item
            key={display.key}
            testID={`triage-session-work-task:${row.entryRef.entryId}`}
            title={display.title}
            subtitle={subtitle || undefined}
            icon={category === null
              ? <Icon name={readTriageEntryGlyphV1(display.lifecyclePresentation, null)} size="small" />
              : <TaskStatusGlyph category={category} />}
            onPress={() => openTask(row)}
          />
        );
      })}
    </ItemGroup>
  );
}

export const renderSurface: RenderSurface = defineUiSurface(() => <TriageSessionWorkTasksSection />);
