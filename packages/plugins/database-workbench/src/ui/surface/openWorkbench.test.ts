import { expect, it, vi } from 'vitest';
import { UI_DATABASE_OPEN_ACTION_ID_V1 } from '@happier-dev/database-protocol';
import { createDatabaseDescriptorV1Fixture } from '@happier-dev/database-protocol/testing/v1';
import { databaseActionLocalIdV1 } from '@happier-dev/plugin-sdk/actions';
import { PLUGIN_MANIFEST } from '../../manifest.js';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import { invokeOpenWorkbench } from './openWorkbench.js';
import { decodeWorkbenchSubPath } from './subPath.js';
import { WORKBENCH_PAGE_ARTIFACT_ID, WORKBENCH_PAGE_VIEW_ID } from './views.js';

it('declares a safe client Action for opening a discovered database', () => {
  const declaration = PLUGIN_MANIFEST.contributes.actions?.find(
    action => action.id === databaseActionLocalIdV1(UI_DATABASE_OPEN_ACTION_ID_V1),
  );
  expect(declaration).toMatchObject({
    execution: { target: 'client', client: { artifactId: WORKBENCH_PAGE_ARTIFACT_ID, exportName: 'activate' } },
    dangerLevel: 'safe',
    readOnly: true,
    surfaces: expect.arrayContaining(['agent', 'ui']),
    inputSchema: expect.any(Object),
    resultSchema: expect.any(Object),
  });
});

it('opens the addressed database and relation through the existing navigation host', async () => {
  const descriptor = createDatabaseDescriptorV1Fixture();
  const place = { mode: 'data', relation: { schema: 'public', name: 'orders/archived' } };
  const openSurface = vi.fn<PluginUiHostApi['openSurface']>().mockResolvedValue(undefined);
  const signal = new AbortController().signal;
  const result = await invokeOpenWorkbench({ descriptor, place }, { ui: { openSurface }, signal });
  expect(result.status).toBe('opened');
  if (result.status !== 'opened') throw new Error('Workbench did not open');
  const { serverId, machineId, installationId } = descriptor.placement;
  const prefix = `~run-on/${serverId}/${machineId}/${installationId}/`;
  expect(result.subPath.startsWith(prefix)).toBe(true);
  expect(decodeWorkbenchSubPath(result.subPath.slice(prefix.length))).toEqual({ target: descriptor.target, place, root: false });
  expect(openSurface).toHaveBeenCalledWith(WORKBENCH_PAGE_VIEW_ID, undefined, { subPath: result.subPath, signal });
  expect(() => invokeOpenWorkbench({ descriptor, place: { mode: 'other' } }, { ui: { openSurface }, signal })).toThrow();
  await expect(invokeOpenWorkbench({ descriptor }, { ui: { openSurface }, signal: AbortSignal.abort() })).resolves.toEqual({ status: 'unavailable' });
  expect(openSurface).toHaveBeenCalledTimes(1);
});
