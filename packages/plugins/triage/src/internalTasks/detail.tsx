import * as React from 'react';
import type { RenderContext, RenderSurface } from '@happier-dev/plugin-sdk/ui';
import type { PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import { TriageDetailSurfaceInputV1Schema } from '@happier-dev/triage-protocol/v1';
import { defineUiSurface, ErrorState, LoadingState, Stack, Status, Text, usePluginHostApi, usePluginTranslation } from '@happier-dev/plugin-ui';
import { sameTriageSourceIdentity } from '../corpus/identity/components.js';
import { INTERNAL_TASK_SOURCE_V1, isInternalTaskReferenceV1, internalTaskOwnerAccountIdV1 } from './identity.js';
import { presentInternalTaskReadFailure } from './readFailure.js';
import { presentTriageMountedUiActionFailure } from '../ui/mountedActions.js';

type Task = Extract<PluginActionResultById['tasks.internal.list'], { status: 'ok' }>['todos'][number];

/** Source-native body; the aggregate owns its frame, task edits and linked work. */
function InternalTaskDetail(context: RenderContext): React.ReactElement {
  const host = usePluginHostApi();
  const text = usePluginTranslation();
  const input = React.useMemo(() => {
    const parsed = TriageDetailSurfaceInputV1Schema.safeParse(context.launchInput);
    if (!parsed.success) return null;
    const entryRef = parsed.data.observation.entryRef;
    return sameTriageSourceIdentity(parsed.data.instance.instance.source, INTERNAL_TASK_SOURCE_V1)
      && isInternalTaskReferenceV1(entryRef)
      ? parsed.data : null;
  }, [context.launchInput]);
  const taskId = input?.observation.entryRef.entryId ?? null;
  const collisionScope = input?.observation.entryRef.collisionScope ?? null;
  const taskKey = JSON.stringify([collisionScope, taskId]);
  const ownerAccountId = input === null || collisionScope === 'personal' ? undefined
    : internalTaskOwnerAccountIdV1(input.observation.entryRef, '') ?? undefined;
  const observedAtMs = input?.observation.observedAtMs ?? null;
  const [read, setRead] = React.useState<Readonly<{ host: typeof host; taskKey: string; task: Task | null; failed: boolean; reason?: string }> | null>(null);
  React.useEffect(() => {
    if (taskId === null) return;
    const controller = new AbortController();
    const fail = () => {
      setRead(previous => ({ host, taskKey, failed: true,
        task: previous?.host === host && previous.taskKey === taskKey ? previous.task : null }));
    };
    void host.executeAction('tasks.internal.read', { taskId, ...(ownerAccountId === undefined ? {} : { ownerAccountId }) }, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      if (result.status === 'refused') { setRead({ host, taskKey, task: null, failed: true, reason: result.reason }); return; }
      if (result.status !== 'applied') { fail(); return; }
      setRead({ host, taskKey, task: result.todo, failed: false });
    }).catch(async (error: unknown) => {
      if (controller.signal.aborted) return;
      fail();
      await presentTriageMountedUiActionFailure(host, error, text);
    });
    return () => controller.abort();
  }, [host, taskId, taskKey, ownerAccountId, observedAtMs, text]);
  // The Host API is Account-bound. Retained notes never cross a replacement authority.
  const currentRead = read?.host === host && read.taskKey === taskKey ? read : null;
  if (taskId === null || (currentRead !== null && currentRead.task === null)) {
    // A shared task says which of its two refusals this is; missing and revoked look identical by design.
    const reason = ownerAccountId === undefined ? undefined : currentRead?.reason;
    return <ErrorState title={presentInternalTaskReadFailure(reason, text)
      ?? text('plugins.triage.internal.unavailable', 'This task could not be read')} />;
  }
  if (!currentRead?.task) return <LoadingState title={text('plugins.triage.internal.loading', 'Reading task…')} />;
  const access = currentRead.task.access;
  return <Stack gap="medium">
    {/* A recipient learns it is someone else's task and whether their edits land; the owner sees nothing extra. */}
    {access === 'view' ? <Text variant="meta" value={text('plugins.triage.internal.sharedViewOnly', 'Shared with you · View only')} />
      : access === 'edit' || access === 'admin'
        ? <Text variant="meta" value={text('plugins.triage.internal.sharedCanEdit', 'Shared with you · You can edit')} /> : null}
    {/* The last good read stays; a failed refresh over it is one quiet line, not an error card above the notes. */}
    {currentRead.failed ? <Status tone="warning" label={text('plugins.triage.internal.unavailable', 'This task could not be read')} /> : null}
    {currentRead.task.notes === undefined ? null : <Text variant="reading" value={currentRead.task.notes} />}
    {/* Labels are a typed property: the aggregate's PropertyList draws them once, above the notes. */}
    {currentRead.task.links?.map(link => <Text key={link.url} variant="meta" value={link.title ? `${link.title} · ${link.url}` : link.url} />)}
  </Stack>;
}

export const renderSurface: RenderSurface = defineUiSurface(InternalTaskDetail);
