/** @vitest-environment jsdom */
import * as React from 'react';
import { View } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Action } from '@happier-dev/plugin-ui';
import {
  PluginHostApiProvider,
  PluginUiHostPresentationScope,
} from '@happier-dev/plugin-ui/advanced';
import { projectHappierUiEnvironment } from '@happier-dev/plugin-ui/environment';
import type { PluginUiSurfaceContextV1 } from '@happier-dev/protocol/plugins/ui';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createPluginSurfaceContextFixture } from '@/dev/testkit/fixtures/pluginSurfaceContextFixture';
import { createCanonicalPluginReactNativeHostApiAdapter } from '@/components/plugins/reactNative/hostApi';
import { createPluginSurfaceHostApi } from './createPluginSurfaceHostApi';
import { createPluginSurfaceActionControls } from './pluginSurfaceActionControls';
import { createPluginUiPrivatePresentationHost } from './pluginUiPrivatePresentationHost';
import { MountedPluginActionControls } from './MountedPluginActionControls';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);

afterEach(() => {
  standardCleanup();
});

const requestSurface: PluginUiSurfaceContextV1 = {
  pluginId: 'com.acme.fixture',
  contributionId: 'surface',
  surfaceId: 'surface',
  placement: 'appSurface',
  platform: 'web',
  channel: 'internal',
  resourceScope: [],
  diagnostics: [],
};

/**
 * A same-realm author tree that presents itself in a dialog (a details pane over the page) keeps its
 * host Action control where the author declared it: inside the dialog, reachable, in its focus order.
 * The physical host button still owns the gesture; only its place changes.
 */
describe('host Action control placement in a same-realm author tree', () => {
  it('renders the host control inside the presentation that hosts its declaration, and its press prepares', async () => {
    // The Action executor's Project transport is the boundary; the control registry, Host API
    // handler and the native carrier stay real.
    const projectAction = vi.fn(async () => ({
      ok: true as const,
      result: {},
    }));
    const executor = createActionExecutor(
      createActionExecutorBoundaryFixture({ projectAction }),
    );
    const lifetime = new AbortController();
    const controls = createPluginSurfaceActionControls({
      pluginId: requestSurface.pluginId,
      surfaceId: requestSurface.surfaceId,
      hostAction: { execute: executor.execute, context: {} },
      signal: lifetime.signal,
      isCurrent: () => true,
      captureCurrentBinding: () => () => true,
    });
    const mount = createPluginSurfaceHostApi({
      surfaceContext: requestSurface,
      isCurrent: () => true,
      handlers: { actionControl: controls.handleRequest },
    });
    const context = createPluginSurfaceContextFixture();
    const adapter = createCanonicalPluginReactNativeHostApiAdapter({
      surface: context,
      requestSurface,
      handleRequest: mount.handleRequest,
      installedMethods: [...mount.admissionMethods],
      getAdmissionMethods: () => [...mount.admissionMethods],
      isCurrent: () => true,
    });
    const prepare = vi.fn(() => null);
    const controller = { prepare, onSettled: () => {} };
    // `surfaceActivity` is the host's private provider prop, as the physical host passes it.
    const hostProps = { hostApi: adapter.api, surfaceActivity: { active: true } };
    const screen = await renderScreen(
      <PluginHostApiProvider
        {...hostProps}
      >
        <PluginUiHostPresentationScope
          environment={projectHappierUiEnvironment(context)}
          presentationHost={createPluginUiPrivatePresentationHost(undefined, {
            actionControls: controls,
          })}
        >
          <View testID="details-dialog" role="dialog" aria-modal>
            <Action.Control
              action="projects.compute.exec"
              controller={controller}
              title="Create task"
            />
          </View>
        </PluginUiHostPresentationScope>
        {/* The mount's slot for carriers whose author tree the host cannot reach. */}
        <View testID="page-band">
          <MountedPluginActionControls controls={controls} />
        </View>
      </PluginHostApiProvider>,
    );
    try {
      await expect.poll(() => controls.getSnapshot().length).toBe(1);
      const id = controls.getSnapshot()[0]!.id;
      const testID = `plugin-surface-action-control:${id}`;
      await expect
        .poll(
          () =>
            screen.root.findAll(
              (node) =>
                node.props.testID === testID && typeof node.type === 'string',
            ).length,
        )
        .toBe(1);
      const dialog = screen.findByTestId('details-dialog')!;
      const band = screen.findByTestId('page-band')!;
      expect(
        dialog.findAll((node) => node.props.testID === testID).length,
      ).toBeGreaterThan(0);
      expect(band.findAll((node) => node.props.testID === testID)).toHaveLength(
        0,
      );
      await screen.pressByTestIdAsync(testID);
      await expect.poll(() => prepare.mock.calls.length).toBe(1);
      expect(projectAction).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
      lifetime.abort();
      adapter.dispose?.();
      mount.dispose?.();
    }
  });
});
