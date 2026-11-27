import * as React from 'react';
import {
    DatabaseDescriptorV1Schema,
    DatabaseTargetsListInputV1Schema,
    type DatabaseDescriptorV1,
    type DatabaseTargetsListInputV1,
    type DatabaseTargetV1,
} from '@happier-dev/plugin-sdk/database';
import { computeSha256HexDigest } from '@happier-dev/plugin-sdk';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { databaseStatementRangesV1 } from '@happier-dev/databases/statements';
import { useHostDatabaseWorkbench } from '@happier-dev/plugin-ui/hostApi';
import {
  createWorkbenchInstance,
  type WorkbenchInstance,
} from '../workbench.js';
import { createConsoleDeviceStorage } from '../consoleDeviceStorage.js';
import type { WorkbenchClient, WorkbenchLocation } from '../models.js';
import { createHostWorkbenchClient } from './hostClient.js';
import type { WorkbenchTargetDisplay } from './subPath.js';
import { workbenchTargetKey } from '../workbench.js';

/**
 * One display window of rows or relations. Paging continues past it through the producer's
 * continuation; this sizes a screenful of work, it never cuts what the person can reach.
 */
export const WORKBENCH_DISPLAY_PAGE_ROWS = 50;

/** Launch input supplies the scope, selected database and optional selection for a details tab. */
export type WorkbenchLaunchInput = Readonly<{
  scope: DatabaseTargetsListInputV1['scope'];
  descriptor?: DatabaseDescriptorV1;
  place?: string;
}>;

export function readWorkbenchLaunchInput(
  context: Pick<RenderContext, 'launchInput' | 'launch' | 'surface'>,
  linkedDescriptor?: DatabaseDescriptorV1,
): WorkbenchLaunchInput | null {
  if (linkedDescriptor) {
    const target = linkedDescriptor.target;
    const scope: WorkbenchLaunchInput['scope'] = 'environment' in target
      ? { kind: 'environment', environment: target.environment }
      : { kind: 'worktree', accountId: target.accountId, workspace: target.workspace,
          installationId: target.installationId, projectKey: target.projectKey };
    return { scope, descriptor: linkedDescriptor };
  }
  const input = context.launchInput ?? context.launch?.input;
  const target = context.surface.target;
  if (input === undefined && (target.kind === 'services' || target.kind === 'session' || target.kind === 'project')) {
    const project = target.kind === 'project' ? target : target.project;
    const { installationId } = target;
    const checkout = project?.checkout;
    const account = context.surface.accountScope;
    if (!checkout || !project || !installationId || !account) return null;
    const parsed = DatabaseTargetsListInputV1Schema.safeParse({ scope: {
      kind: 'worktree', accountId: account.accountId, installationId, projectKey: project.projectKey,
      workspace: { serverId: checkout.serverId, machineId: checkout.machineId, workspaceId: checkout.id, rootPath: checkout.rootPath },
    } });
    return parsed.success ? { scope: parsed.data.scope } : null;
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  // Launch input is host-delivered JSON; the P1 owner's own parsers admit the place and the database.
  const fields = input as Readonly<Record<string, unknown>>;
  const scope = DatabaseTargetsListInputV1Schema.safeParse({ scope: fields.scope });
  if (!scope.success) return null;
  const launch = { scope: scope.data.scope, ...(typeof fields.place === 'string' ? { place: fields.place } : {}) };
  if (fields.descriptor === undefined) return launch;
  const descriptor = DatabaseDescriptorV1Schema.safeParse(fields.descriptor);
  return descriptor.success ? { ...launch, descriptor: descriptor.data } : null;
}

export function databaseTargetKey(descriptor: DatabaseDescriptorV1): string {
  // The instance keys targets by their canonical JSON; the page and the panel share that owner.
  return workbenchTargetKey(descriptor.target);
}

export function workbenchDetailsInstanceKey(targetKey: string, place: string): string {
  return computeSha256HexDigest(JSON.stringify([targetKey, place]));
}

function useNoWorktreeTargetChanges() {}

/** The physical mount owns one workbench instance until it unmounts. */
export function useWorkbenchMount(
  context: RenderContext,
  launch: WorkbenchLaunchInput | null,
  location: WorkbenchLocation | null,
  options: Readonly<{ pageLocation: boolean }>,
  linkedClient?: WorkbenchClient,
): WorkbenchInstance | null {
  const { hostApi } = context;
  const databaseHost = useHostDatabaseWorkbench();
  const useWorktreeTargetChanges = databaseHost?.useWorktreeTargetChanges ?? useNoWorktreeTargetChanges;
  const activityResource = databaseHost?.activityResource;
  const lastLook = databaseHost?.lastLook;
  const accountScope = context.surface.accountScope;
  const scopeKey = launch ? JSON.stringify(launch.scope) : null;
  const instance = React.useMemo(() => {
    if (!launch || !location) return null;
    return createWorkbenchInstance({
      client: linkedClient ?? createHostWorkbenchClient(hostApi, options),
      scope: launch.scope,
      location,
      ...(launch.descriptor ? { selectedTarget: launch.descriptor } : {}),
      cataloguePageRows: WORKBENCH_DISPLAY_PAGE_ROWS,
      consoleStorage: (descriptor) =>
        createConsoleDeviceStorage(hostApi, descriptor),
      statementRanges: databaseStatementRangesV1,
      activityResource,
      lastLook: lastLook && accountScope ? target => lastLook(accountScope, target) : undefined,
    });
    // A new scope is a different workbench; location changes go through the instance's navigation owner.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostApi, scopeKey, linkedClient, options.pageLocation, activityResource, lastLook, accountScope?.serverId, accountScope?.accountId]);
  const invalidateTargets = React.useCallback(() => {
    if (instance) instance.targets(instance.scope).invalidate();
  }, [instance]);
  const discoveryScope = instance && !launch?.descriptor && instance.scope.kind === 'worktree' ? instance.scope : null;
  useWorktreeTargetChanges(discoveryScope, invalidateTargets);
  const attached = React.useRef<WorkbenchInstance | null>(null);
  React.useEffect(() => {
    if (!instance) return;
    attached.current = instance;
    return () => {
      if (attached.current === instance) attached.current = null;
      // StrictMode reconnects passive effects synchronously; only a still-detached instance
      // closes, one microtask later (the host's surface-owner lifetime pattern).
      queueMicrotask(() => { if (attached.current !== instance) instance.close(); });
    };
  }, [instance]);
  return instance;
}

type LinkedWorkbenchFailure = { status: 'unavailable'; error: unknown };
type LinkedWorkbenchReady = Awaited<ReturnType<ReturnType<typeof createHostWorkbenchClient>['describe']>>
  & { status: 'ready'; client: WorkbenchClient };

type LinkedWorkbench =
  | { status: 'loading' }
  | (LinkedWorkbenchFailure & { retry(): void })
  | LinkedWorkbenchReady;

export function useLinkedWorkbench(
  context: RenderContext, target: DatabaseTargetV1, display: WorkbenchTargetDisplay | undefined,
): LinkedWorkbench {
  const { hostApi } = context;
  const targetKey = workbenchTargetKey(target);
  const [attempt, setAttempt] = React.useState(0);
  const retry = React.useCallback(() => setAttempt(current => current + 1), []);
  const [settled, setSettled] = React.useState<{
    hostApi: RenderContext['hostApi'];
    targetKey: string;
    attempt: number;
    result: LinkedWorkbenchFailure | LinkedWorkbenchReady;
  }>();
  React.useEffect(() => {
    const client = createHostWorkbenchClient(hostApi, { pageLocation: true, pageTarget: target,
      pageDisplay: display });
    let active = true;
    const request = new AbortController();
    void client.describe(target, request.signal).then(
      description => {
        if (active) setSettled({ hostApi, targetKey, attempt, result: { status: 'ready', ...description, client } });
      },
      error => {
        if (active) setSettled({ hostApi, targetKey, attempt, result: { status: 'unavailable', error } });
      },
    );
    return () => {
      active = false;
      request.abort();
      client.dispose();
    };
    // The target key keeps the same demand when only the relation changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostApi, targetKey, attempt]);
  if (settled?.hostApi !== hostApi || settled.targetKey !== targetKey || settled.attempt !== attempt)
    return { status: 'loading' };
  return settled.result.status === 'unavailable' ? { ...settled.result, retry } : settled.result;
}
