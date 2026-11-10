import { describe, expect, it, vi } from 'vitest';

import { normalizePluginUiSettingsPageBindingV1 } from '@happier-dev/protocol/plugins/ui';

import {
  EMPTY_PLUGIN_UI_PROJECTION,
  type PluginUiProjectionModel,
  type PluginUiSettingsPageProjection,
} from '@/sync/domains/plugins/ui/projection';
import type { PluginSurfaceDestinationOpenResolution } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import { readPluginSettingsPageRouteParams } from '../catalog/runtime/pluginSettingsPageCatalog';

import { createPluginSettingsPageDestinationHandler } from './pluginSettingsPageNavigation';

const binding = normalizePluginUiSettingsPageBindingV1({
  pluginId: 'acme.channels',
  pageId: 'connections',
  rendererId: 'renderer',
});
if (!binding)
  throw new Error('settings fixture needs a registry-normalized binding');

const page: PluginUiSettingsPageProjection = {
  id: 'settingsPage:acme.channels:connections',
  pluginId: 'acme.channels',
  contributionKind: 'settingsPage',
  descriptorId: 'connections',
  page: {
    id: { pluginId: 'acme.channels', localId: 'connections' },
    group: { kind: 'host', id: 'general' },
    title: 'Channels',
  },
  binding,
  renderer: { kind: 'declarative' },
  availability: { state: 'available', reason: 'available', diagnostics: [] },
};

const projection: PluginUiProjectionModel = {
  ...EMPTY_PLUGIN_UI_PROJECTION,
  settingsPagesById: Object.freeze({ [page.id]: page }),
};

function resolution(
  subPath?: string,
): PluginSurfaceDestinationOpenResolution<PluginUiSettingsPageProjection> {
  return {
    placement: page,
    request: {
      destination: { pluginId: 'acme.channels', localId: 'connections' },
      ...(subPath === undefined ? {} : { subPath }),
    },
  } as PluginSurfaceDestinationOpenResolution<PluginUiSettingsPageProjection>;
}

function routeParams(href: string) {
  const url = new URL(href, 'https://internal.invalid');
  const [, , , pluginId, pageId] = url.pathname
    .split('/')
    .map(decodeURIComponent);
  return readPluginSettingsPageRouteParams({
    pluginId,
    pageId,
    ...Object.fromEntries(url.searchParams),
  });
}

describe('createPluginSettingsPageDestinationHandler', () => {
  it('opens the Settings page at the location its caller named, from inside and outside Settings', async () => {
    for (const pathname of ['/settings/account', '/inbox']) {
      const navigate = vi.fn();
      const open = createPluginSettingsPageDestinationHandler({
        projection,
        locale: 'en',
        pathname,
        navigate,
      });

      await expect(open(resolution('bots/connection-1'))).toEqual({ ok: true });
      expect(navigate).toHaveBeenCalledTimes(1);
      expect(routeParams(navigate.mock.calls[0]![0])).toEqual({
        pluginId: 'acme.channels',
        pageId: 'connections',
        subPath: 'bots/connection-1',
      });
    }
  });

  it('opens the page root when no location is named, and moves to a named location on the page already open', async () => {
    const root = '/settings/plugins/acme.channels/connections';
    const navigate = vi.fn();
    const open = createPluginSettingsPageDestinationHandler({
      projection,
      locale: 'en',
      pathname: root,
      navigate,
    });

    await open(resolution());
    expect(navigate).not.toHaveBeenCalled();
    await open(resolution('bots/connection-2'));
    expect(routeParams(navigate.mock.calls[0]![0])?.subPath).toBe(
      'bots/connection-2',
    );
  });
});
