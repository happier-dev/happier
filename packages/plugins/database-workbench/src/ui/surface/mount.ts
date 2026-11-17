import * as React from 'react';
import {
  DatabaseDescriptorV1Schema,
  DatabaseTargetsListInputV1Schema,
  type DatabaseDescriptorV1,
  type DatabaseTargetsListInputV1,
} from '@happier-dev/database-protocol';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import {
  createWorkbenchInstance,
  type WorkbenchInstance,
} from '../workbench.js';
import { createConsoleDeviceStorage } from '../consoleDeviceStorage.js';
import type { WorkbenchLocation } from '../models.js';
import { createHostWorkbenchClient } from './hostClient.js';

/**
 * One display window of rows or relations. Paging continues past it through the producer's
 * continuation; this sizes a screenful of work, it never cuts what the person can reach.
 */
export const WORKBENCH_DISPLAY_PAGE_ROWS = 50;

/** What a mount is opened with: the place to look, and on the page the database chosen there. */
export type WorkbenchLaunchInput = Readonly<{
  scope: DatabaseTargetsListInputV1['scope'];
  descriptor?: DatabaseDescriptorV1;
}>;

export function readWorkbenchLaunchInput(context: Pick<RenderContext, 'launchInput' | 'launch' | 'surface'>): WorkbenchLaunchInput | null {
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
  if (fields.descriptor === undefined) return { scope: scope.data.scope };
  const descriptor = DatabaseDescriptorV1Schema.safeParse(fields.descriptor);
  return descriptor.success ? { scope: scope.data.scope, descriptor: descriptor.data } : null;
}

export function databaseTargetKey(descriptor: DatabaseDescriptorV1): string {
  // The instance keys targets by their canonical JSON; the page and the panel share that owner.
  return JSON.stringify(descriptor.target);
}

/**
 * Statement ranges come from P1's dialect lexers, which are not yet published on a UI-safe
 * subpath. Until they are, the editor's text is one statement; the producer refuses a
 * multi-statement read with its typed error, which the console shows in place.
 */
function wholeTextStatement(
  sql: string,
): readonly Readonly<{ start: number; end: number }>[] {
  return sql.trim().length ? [{ start: 0, end: sql.length }] : [];
}

/** The physical mount owns one workbench instance until it unmounts. */
export function useWorkbenchMount(
  context: RenderContext,
  launch: WorkbenchLaunchInput | null,
  location: WorkbenchLocation | null,
  options: Readonly<{ pageLocation: boolean }>,
): WorkbenchInstance | null {
  const { hostApi } = context;
  const scopeKey = launch ? JSON.stringify(launch.scope) : null;
  const instance = React.useMemo(() => {
    if (!launch || !location) return null;
    return createWorkbenchInstance({
      client: createHostWorkbenchClient(hostApi, options),
      scope: launch.scope,
      location,
      ...(launch.descriptor ? { selectedTarget: launch.descriptor } : {}),
      cataloguePageRows: WORKBENCH_DISPLAY_PAGE_ROWS,
      consoleStorage: (descriptor) =>
        createConsoleDeviceStorage(hostApi, descriptor),
      statementRanges: wholeTextStatement,
    });
    // A new scope is a different workbench; location changes go through the instance's navigation owner.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostApi, scopeKey, options.pageLocation]);
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
