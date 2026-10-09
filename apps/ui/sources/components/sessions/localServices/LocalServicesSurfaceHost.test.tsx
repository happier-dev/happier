import * as fs from 'node:fs';
import * as path from 'node:path';

import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  FeatureDecision,
  FeatureId,
  RuntimeActionExecute,
} from '@happier-dev/protocol';
import { buildLocalServiceInventoryState } from '@/dev/testkit/fixtures/localServices';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import {
  pressTestInstanceAsync,
  renderScreen,
} from '@/dev/testkit/render/renderScreen';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import {
  createUiApprovalRequest,
  decideApprovalAsInbox,
} from '@/dev/testkit/harness/approvalInbox';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';

// Genuine credential/HTTP boundaries are installed before importing the mounted
// host. Its credential lifetime, row projection and Action admission stay real.
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const inventoryMachineRpc =
  await import('@/sync/domains/local/services/inventory/machineRpc');
const { resetLocalServiceInventoryStoreForTests } =
  await import('@/sync/domains/local/services/inventory/sharedStore');
const { resetLocalServiceLauncherStoreForTests } =
  await import('@/sync/domains/local/services/launch/sharedStore');
const { applyLocalServiceLauncherSnapshot, createLocalServiceLauncherState } =
  await import('@/sync/domains/local/services/launch');
const { ItemRowActions } = await import('@/components/ui/lists/ItemRowActions');
const { LocalServicesSurfaceHost } = await import('./LocalServicesSurfaceHost');

const useFeatureDecisionMock = vi.hoisted(() =>
  vi.fn((featureId: FeatureId, _scope?: unknown): FeatureDecision => ({
    featureId,
    state: 'enabled',
    blockedBy: null,
    blockerCode: 'none',
    diagnostics: [],
    evaluatedAt: 1,
    scope: { scopeKind: 'runtime' },
  })),
);
const pluginProjectionState = vi.hoisted(() => ({
  appShell: {
    pluginUiProjection: null as unknown,
    machineId: 'machine-global' as string | null,
    serverId: 'server-global' as string | null,
    platform: 'web' as const,
  },
  scoped: {
    pluginUiProjection: null as unknown,
    machineId: 'machine-a' as string | null,
    serverId: 'server-a' as string | null,
    platform: 'web' as const,
  },
  scopedInputs: [] as unknown[],
  stackProps: [] as Record<string, unknown>[],
}));

vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ confirmResult: true }).module;
});

vi.mock('@/hooks/server/useFeatureDecision', () => ({
  useFeatureDecision: (featureId: FeatureId, scope?: unknown) =>
    useFeatureDecisionMock(featureId, scope),
}));

vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
  useAppShellPluginUiProjection: () => pluginProjectionState.appShell,
}));

vi.mock('@/components/plugins/projection/useScopedPluginUiProjection', () => ({
  useScopedPluginUiProjection: (params: unknown) => {
    pluginProjectionState.scopedInputs.push(params);
    return pluginProjectionState.scoped;
  },
}));

vi.mock('@/components/plugins/surfaces', () => ({
  PluginSurfacePlacementStack: (props: Record<string, unknown>) => {
    pluginProjectionState.stackProps.push(props);
    return React.createElement('PluginSurfacePlacementStackStub', {
      ...props,
      testID: props.testID,
    });
  },
}));

const openableTarget: LocalServiceLaunchTarget = {
  id: 'preview:host-feed',
  source: 'registered_preview',
  machineId: 'machine-a',
  sessionId: 'session-a',
  title: 'Host feed preview',
  subtitle: 'localhost:5173',
  confidence: 'high',
  state: 'available',
  actions: [],
  browserTarget: {
    kind: 'localServicePreview',
    targetId: 'preview-host',
    sessionId: 'session-a',
    machineId: 'machine-a',
  },
};

function buildLauncherState() {
  return applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), {
    v: 1,
    machineId: 'machine-a',
    sessionId: 'session-a',
    updatedAt: 3_000,
    targets: [openableTarget],
  });
}

describe('LocalServicesSurfaceHost', () => {
  beforeEach(async () => {
    await home.reset();
    useFeatureDecisionMock.mockImplementation(
      (featureId: FeatureId): FeatureDecision => ({
        featureId,
        state: 'enabled',
        blockedBy: null,
        blockerCode: 'none',
        diagnostics: [],
        evaluatedAt: 1,
        scope: { scopeKind: 'runtime' },
      }),
    );
    pluginProjectionState.appShell = {
      pluginUiProjection: null,
      machineId: 'machine-global',
      serverId: 'server-global',
      platform: 'web',
    };
    pluginProjectionState.scoped = {
      pluginUiProjection: null,
      machineId: 'machine-a',
      serverId: 'server-a',
      platform: 'web',
    };
    pluginProjectionState.scopedInputs = [];
    pluginProjectionState.stackProps = [];
    resetLocalServiceInventoryStoreForTests();
    resetLocalServiceLauncherStoreForTests();
  });

  afterEach(async () => {
    resetLocalServiceInventoryStoreForTests();
    resetLocalServiceLauncherStoreForTests();
    await home.reset();
  });

  it('renders the detected services pane and the Services-bound plugin stack under the testID prefix', async () => {
    const screen = await renderScreen(
      <LocalServicesSurfaceHost
        machineId="machine-a"
        serverId="server-a"
        sessionId="session-a"
        inventoryState={buildLocalServiceInventoryState({ rows: [] })}
        launcherState={buildLauncherState()}
        testID="surface-host-services"
      />,
    );

    expect(
      screen.findByTestId('surface-host-services-row:preview:host-feed'),
    ).toBeTruthy();
    expect(
      screen.findByTestId('surface-host-services-plugin-stack'),
    ).toBeTruthy();
    expect(pluginProjectionState.stackProps.at(-1)).toMatchObject({
      container: 'servicesPanel',
      targetKind: 'services',
    });
  });

  it('threads the explicit sessionId into the pane so this-session grouping uses it (§5.6)', async () => {
    const screen = await renderScreen(
      <LocalServicesSurfaceHost
        machineId="machine-a"
        serverId="server-a"
        sessionId="session-a"
        inventoryState={buildLocalServiceInventoryState({ rows: [] })}
        launcherState={buildLauncherState()}
        testID="surface-host-services"
      />,
    );
    // The session-a preview is attributed to this session (explicit sessionId threaded host→pane),
    // so it reads "This session" in the Running section.
    expect(
      screen.findByTestId('surface-host-services-section-running'),
    ).toBeTruthy();
    expect(screen.getTextContent()).toContain('This session');
  });

  it('invokes the injected onOpenServiceInBrowser callback with the launch target when the open affordance fires', async () => {
    const onOpenServiceInBrowser = vi.fn();
    const screen = await renderScreen(
      <LocalServicesSurfaceHost
        machineId="machine-a"
        serverId="server-a"
        sessionId="session-a"
        inventoryState={buildLocalServiceInventoryState({ rows: [] })}
        launcherState={buildLauncherState()}
        onOpenServiceInBrowser={onOpenServiceInBrowser}
        testID="surface-host-services"
      />,
    );

    await pressTestInstanceAsync(
      screen.findByTestId('surface-host-services-row:preview:host-feed-item'),
      'surface-host-services-row:preview:host-feed-item',
    );
    await pressTestInstanceAsync(
      screen.findByTestId('surface-host-services-row:preview:host-feed-open'),
      'surface-host-services-row:preview:host-feed-open',
    );

    expect(onOpenServiceInBrowser).toHaveBeenCalledExactlyOnceWith(
      openableTarget,
    );
  });

  it('reviews Restart explicitly and binds exact Project controls to the initiating Home Account', async () => {
    const serverId = await home.addHome({
      name: 'Service Home',
      serverUrl: 'https://services-host.test',
      accountId: 'initiating-account',
      currentAccount: true,
    });
    const requests: Parameters<RuntimeActionExecute>[0][] = [];
    // The front-door Action executor is the transport boundary; the host, row model and row are real.
    const runtimeActionExecute: RuntimeActionExecute = async (request) => {
      requests.push(request);
      const input = request.input as {
        requestId: string;
        action: string;
        expectedEffectDigest?: string;
      };
      return {
        v: 1,
        requestId: input.requestId,
        action: input.action,
        status:
          request.actionId === 'localServices.actions.restartManaged' &&
          !input.expectedEffectDigest
            ? 'denied'
            : 'succeeded',
        ...(!input.expectedEffectDigest &&
        request.actionId === 'localServices.actions.restartManaged'
          ? {
              reasonCode: 'project_service_effect_review_required',
              reviewedEffect: { command: 'current service' },
              reviewedEffectDigest: 'reviewed-service-effect',
            }
          : {}),
        auditEvents: [],
      };
    };
    const managed: LocalServiceLaunchTarget = {
      id: 'project-service:jobs',
      source: 'managed_service',
      sourceClass: { kind: 'managed_service', managedServiceId: 'owned-jobs' },
      machineId: 'machine-a',
      workspaceId: 'accepted',
      cwd: '/repo',
      workspace: {
        serverId,
        machineId: 'machine-a',
        workspaceId: 'accepted',
        rootPath: '/repo',
      },
      declaration: {
        workspaceRefId: 'accepted',
        selection: { kind: 'manifest', name: 'jobs' },
      },
      title: 'jobs',
      confidence: 'high',
      state: 'available',
      serviceState: 'running',
      actions: ['manage'],
    };
    const screen = await renderScreen(
      <LocalServicesSurfaceHost
        machineId="machine-a"
        serverId={serverId}
        workspaceRoot="/repo"
        inventoryState={buildLocalServiceInventoryState({ rows: [] })}
        launcherState={applyLocalServiceLauncherSnapshot(
          createLocalServiceLauncherState(),
          {
            v: 1,
            machineId: 'machine-a',
            updatedAt: 1,
            targets: [managed],
          },
        )}
        runtimeActionExecute={runtimeActionExecute}
        testID="surface-host-services"
      />,
    );
    await flushHookEffects();
    const menus = screen.findAllByType(ItemRowActions);
    const actions = menus.flatMap(
      (menu) =>
        (menu.props as { actions: Array<{ id: string; onPress: () => void }> })
          .actions,
    );
    await act(async () => {
      actions.find((action) => action.id === 'restart')!.onPress();
    });
    await flushHookEffects();
    // The host draws the disclosed effect itself; only the person's Restart rejoins the Action.
    expect(requests).toHaveLength(1);
    await act(async () => {
      screen.pressByTestId('surface-host-services-effect-review-approve');
    });
    await flushHookEffects();
    await act(async () => {
      actions.find((action) => action.id === 'stop')!.onPress();
    });
    await flushHookEffects();
    expect(requests.map((request) => request.actionId)).toEqual([
      'localServices.actions.restartManaged',
      'localServices.actions.restartManaged',
      'localServices.actions.stopManaged',
    ]);
    expect(
      requests.every(
        (request) =>
          Reflect.get(request.context ?? {}, 'expectedAccountId') ===
          'initiating-account',
      ),
    ).toBe(true);
    expect(requests[1]).toMatchObject({
      input: { expectedEffectDigest: 'reviewed-service-effect' },
    });
    expect(requests[2]).toMatchObject({
      input: {
        action: 'stop_managed',
        target: {
          kind: 'managed_service',
          managedServiceId: 'owned-jobs',
          machineId: 'machine-a',
          cwd: '/repo',
          declaration: managed.declaration,
        },
      },
    });
  });

  it('retires a held Project effect review when its exact Home Account changes', async () => {
    const serverId = await home.addHome({
      name: 'Service Home',
      serverUrl: 'https://services-review-retirement.test',
      accountId: 'initiating-account',
      currentAccount: true,
    });
    const runtimeActionExecute = vi.fn<RuntimeActionExecute>(
      async (request) => ({
        protocolVersion: 1,
        machineId: 'machine-a',
        targetId: 'project-service:jobs',
        status: 'denied',
        reasonCode: 'project_service_effect_review_required',
        reviewedEffect: { command: 'current service' },
        reviewedEffectDigest: 'a'.repeat(64),
        snapshot: { v: 1, machineId: 'machine-a', updatedAt: 1, targets: [] },
      }),
    );
    const target: LocalServiceLaunchTarget = {
      id: 'project-service:jobs',
      source: 'managed_service',
      sourceClass: {
        kind: 'managed_service',
        managedServiceId: 'declared-jobs',
      },
      machineId: 'machine-a',
      title: 'jobs',
      confidence: 'high',
      state: 'available',
      actions: ['start'],
      cwd: '/repo',
      workspace: {
        serverId,
        machineId: 'machine-a',
        workspaceId: 'accepted',
        rootPath: '/repo',
      },
      declaration: {
        workspaceRefId: 'accepted',
        selection: { kind: 'manifest', name: 'jobs' },
      },
    };
    const screen = await renderScreen(
      <LocalServicesSurfaceHost
        serverId={serverId}
        machineId="machine-a"
        workspaceRoot="/repo"
        inventoryState={buildLocalServiceInventoryState({ rows: [] })}
        launcherState={applyLocalServiceLauncherSnapshot(
          createLocalServiceLauncherState(),
          {
            v: 1,
            machineId: 'machine-a',
            updatedAt: 1,
            targets: [target],
          },
        )}
        runtimeActionExecute={runtimeActionExecute}
        testID="service-retirement"
      />,
    );
    await flushHookEffects();
    act(() => {
      screen.pressByTestId('service-retirement-row:project-service:jobs-start');
    });
    await flushHookEffects();
    expect(runtimeActionExecute).toHaveBeenCalledOnce();
    expect(screen.findByTestId('service-retirement-effect-review')).toBeTruthy();
    await act(async () => {
      await home.switchAccount(serverId, 'replacement-account');
    });
    // The review retires with its exact Account: nothing is left to approve and nothing re-enters.
    await waitForHomeGovernance(() =>
      expect(screen.findAllByTestId('service-retirement-effect-review')).toHaveLength(0),
    );
    await flushHookEffects();
    expect(runtimeActionExecute).toHaveBeenCalledOnce();
  });

  /**
   * R2a-F1 / R2b-02: the real Project mounts pass no review callback. The host itself renders the
   * current effect the daemon disclosed and rejoins the same Start Action with that digest; Not now
   * re-enters nothing.
   */
  it('reviews a declared service Start in the host itself and rejoins the same Action with the disclosed digest', async () => {
    const serverId = await home.addHome({
      name: 'Service Home',
      serverUrl: 'https://services-effect-review.test',
      accountId: 'initiating-account',
      currentAccount: true,
    });
    const digest = 'b'.repeat(64);
    const runtimeActionExecute = vi.fn<RuntimeActionExecute>(
      async (request) => {
        const input = request.input as { expectedEffectDigest?: string };
        return input.expectedEffectDigest === digest
          ? {
              protocolVersion: 1,
              machineId: 'machine-a',
              targetId: 'project-service:web',
              status: 'succeeded',
              snapshot: {
                v: 1,
                machineId: 'machine-a',
                updatedAt: 2,
                targets: [],
              },
            }
          : {
              protocolVersion: 1,
              machineId: 'machine-a',
              targetId: 'project-service:web',
              status: 'denied',
              reasonCode: 'project_service_effect_review_required',
              reviewedEffectDigest: digest,
              reviewedEffect: {
                v: 1,
                purpose: 'service',
                command: {
                  source: { kind: 'native' },
                  executable: 'yarn',
                  args: ['dev:ui'],
                  cwd: '.',
                },
              },
              snapshot: {
                v: 1,
                machineId: 'machine-a',
                updatedAt: 1,
                targets: [],
              },
            };
      },
    );
    const target: LocalServiceLaunchTarget = {
      id: 'project-service:web',
      source: 'managed_service',
      sourceClass: {
        kind: 'managed_service',
        managedServiceId: 'declared-web',
      },
      machineId: 'machine-a',
      title: 'web',
      confidence: 'high',
      state: 'available',
      actions: ['start'],
      cwd: '/repo',
      workspace: {
        serverId,
        machineId: 'machine-a',
        workspaceId: 'accepted',
        rootPath: '/repo',
      },
      declaration: {
        workspaceRefId: 'accepted',
        selection: { kind: 'manifest', name: 'web' },
      },
    };
    const render = () =>
      renderScreen(
        <LocalServicesSurfaceHost
          serverId={serverId}
          machineId="machine-a"
          workspaceRoot="/repo"
          inventoryState={buildLocalServiceInventoryState({ rows: [] })}
          launcherState={applyLocalServiceLauncherSnapshot(
            createLocalServiceLauncherState(),
            {
              v: 1,
              machineId: 'machine-a',
              updatedAt: 1,
              targets: [target],
            },
          )}
          runtimeActionExecute={runtimeActionExecute}
          testID="service-review"
        />,
      );

    const declined = await render();
    await flushHookEffects();
    act(() => {
      declined.pressByTestId('service-review-row:project-service:web-start');
    });
    await flushHookEffects();
    expect(declined.findByTestId('service-review-effect-review')).toBeTruthy();
    expect(declined.getTextContent()).toContain('yarn dev:ui');
    await act(async () => {
      declined.pressByTestId('service-review-effect-review-reject');
    });
    await flushHookEffects();
    expect(runtimeActionExecute).toHaveBeenCalledOnce();
    expect(
      declined.findAllByTestId('service-review-effect-review'),
    ).toHaveLength(0);
    act(() => { declined.tree.unmount(); });

    runtimeActionExecute.mockClear();
    const accepted = await render();
    await flushHookEffects();
    act(() => {
      accepted.pressByTestId('service-review-row:project-service:web-start');
    });
    await flushHookEffects();
    await act(async () => {
      accepted.pressByTestId('service-review-effect-review-approve');
    });
    await flushHookEffects();
    expect(
      runtimeActionExecute.mock.calls.map(([request]) => [
        request.actionId,
        (request.input as { expectedEffectDigest?: string })
          .expectedEffectDigest,
      ]),
    ).toEqual([
      ['localServices.launcher.start', undefined],
      ['localServices.launcher.start', digest],
    ]);
    expect(
      accepted.findAllByTestId('service-review-effect-review'),
    ).toHaveLength(0);
  });

  it('holds managed Stop until the mounted exact-Account Artifact reader observes the durable decision', async () => {
    const serverId = await home.addHome({
      name: 'Service Home',
      serverUrl: 'https://services-stop-approval.test',
      accountId: 'initiating-account',
      currentAccount: true,
    });
    await home.requireUiApproval(serverId, 'localServices.actions.stopManaged');
    let artifactId: string | undefined;
    const runtimeActionExecute: RuntimeActionExecute = async (request) => {
      artifactId = await createUiApprovalRequest({
        serverId,
        actionId: request.actionId,
        actionInput: request.input,
        actionRequestId: 'mounted-service-stop',
      });
      return {
        kind: 'approval_request_created',
        actionId: request.actionId,
        artifactId,
      };
    };
    const target: LocalServiceLaunchTarget = {
      id: 'project-service:jobs',
      source: 'managed_service',
      sourceClass: { kind: 'managed_service', managedServiceId: 'owned-jobs' },
      machineId: 'machine-a',
      title: 'jobs',
      confidence: 'high',
      state: 'available',
      serviceState: 'running',
      actions: ['manage'],
      cwd: '/repo',
      workspace: {
        serverId,
        machineId: 'machine-a',
        workspaceId: 'accepted',
        rootPath: '/repo',
      },
      declaration: {
        workspaceRefId: 'accepted',
        selection: { kind: 'manifest', name: 'jobs' },
      },
    };
    const screen = await renderScreen(
      <LocalServicesSurfaceHost
        serverId={serverId}
        machineId="machine-a"
        workspaceRoot="/repo"
        inventoryState={buildLocalServiceInventoryState({ rows: [] })}
        launcherState={applyLocalServiceLauncherSnapshot(
          createLocalServiceLauncherState(),
          {
            v: 1,
            machineId: 'machine-a',
            updatedAt: 1,
            targets: [target],
          },
        )}
        runtimeActionExecute={runtimeActionExecute}
        testID="service-stop-approval"
      />,
    );
    await flushHookEffects();
    const stop = screen
      .findAllByType(ItemRowActions)
      .flatMap(
        (menu) =>
          (
            menu.props as {
              actions: Array<{ id: string; onPress: () => void }>;
            }
          ).actions,
      )
      .find((action) => action.id === 'stop');
    await act(async () => {
      stop!.onPress();
    });
    await waitForHomeGovernance(() => expect(artifactId).toBeDefined());
    await waitForHomeGovernance(() =>
      expect(
        home.requests.some((request) =>
          request.path.startsWith(`/v1/artifacts/${artifactId}`),
        ),
      ).toBe(true),
    );
    const isPending = () =>
      screen
        .findAllByTestId('service-stop-approval-row:project-service:jobs-item')
        .some((node) => node.props.loading === true);
    expect(isPending()).toBe(true);
    const body = home.artifacts(serverId).readPlainBody(artifactId!);
    expect(body && JSON.parse(body)).toMatchObject({
      status: 'open',
      actionId: 'localServices.actions.stopManaged',
      executionOriginV1: { accountId: 'initiating-account' },
      actionArgs: {
        target: {
          managedServiceId: 'owned-jobs',
          declaration: target.declaration,
        },
      },
    });
    await expect(
      decideApprovalAsInbox(serverId, artifactId!, 'reject'),
    ).resolves.toMatchObject({ ok: true });
    await flushHookEffects();
    await waitForHomeGovernance(() => expect(isPending()).toBe(false));
    expect(
      home.artifacts(serverId).readPlainBody(artifactId!) &&
        JSON.parse(home.artifacts(serverId).readPlainBody(artifactId!)!),
    ).toMatchObject({ status: 'rejected' });
    // Rejecting approval must never pretend that the actual service stopped.
    expect(screen.getTextContent()).toContain('Running');
  });

  it('does not render the open affordance when no onOpenServiceInBrowser callback is supplied', async () => {
    const screen = await renderScreen(
      <LocalServicesSurfaceHost
        machineId="machine-a"
        serverId="server-a"
        sessionId="session-a"
        inventoryState={buildLocalServiceInventoryState({ rows: [] })}
        launcherState={buildLauncherState()}
        testID="surface-host-services"
      />,
    );

    expect(
      screen.findAllByTestId(
        'surface-host-services-row:preview:host-feed-open',
      ),
    ).toHaveLength(0);
  });

  it('passes the host-selected Services origin and session to plugin services surfaces', async () => {
    pluginProjectionState.appShell = {
      pluginUiProjection: { generation: 1, surfacePlacementsById: {} },
      machineId: 'machine-global',
      serverId: 'server-global',
      platform: 'web',
    };
    pluginProjectionState.scoped = {
      pluginUiProjection: { generation: 2, surfacePlacementsById: {} },
      machineId: 'machine-a',
      serverId: 'server-a',
      platform: 'web',
    };

    await renderScreen(
      <LocalServicesSurfaceHost
        machineId="machine-a"
        serverId="server-a"
        sessionId="session-a"
        inventoryState={buildLocalServiceInventoryState({ rows: [] })}
        launcherState={buildLauncherState()}
        testID="surface-host-services"
      />,
    );

    const stackProps = pluginProjectionState.stackProps.at(-1);
    expect(stackProps?.pluginUiProjection).toEqual({
      generation: 2,
      surfacePlacementsById: {},
    });
    expect(stackProps?.machineId).toBe('machine-a');
    expect(stackProps?.serverId).toBe('server-a');
    expect(stackProps?.sessionId).toBe('session-a');
  });

  it('does not substitute a scoped projection machine for a missing Services host origin', async () => {
    pluginProjectionState.scoped = {
      pluginUiProjection: { generation: 2, surfacePlacementsById: {} },
      machineId: 'machine-arbitrary-current',
      serverId: 'server-arbitrary-current',
      platform: 'web',
    };

    await renderScreen(
      <LocalServicesSurfaceHost
        inventoryState={buildLocalServiceInventoryState({ rows: [] })}
        launcherState={buildLauncherState()}
        testID="surface-host-services"
      />,
    );

    const stackProps = pluginProjectionState.stackProps.at(-1);
    expect(stackProps?.machineId).toBeNull();
    expect(stackProps?.serverId).toBeNull();
    expect(stackProps?.sessionId).toBeUndefined();
    expect(stackProps).not.toHaveProperty('runtimeActionExecute');
  });

  it('keeps an admitted unavailable Services projection unavailable instead of self-resolving ambient state', async () => {
    pluginProjectionState.scoped = {
      pluginUiProjection: { generation: 2, surfacePlacementsById: {} },
      machineId: 'machine-ambient',
      serverId: 'server-ambient',
      platform: 'web',
    };

    await renderScreen(
      <LocalServicesSurfaceHost
        machineId="machine-pane-driver"
        serverId="server-pane-driver"
        sessionId="session-a"
        inventoryState={buildLocalServiceInventoryState({ rows: [] })}
        launcherState={buildLauncherState()}
        pluginUiProjection={null}
        projectionInteractionEnabled={false}
        platform="web"
        testID="surface-host-services"
      />,
    );

    const stackProps = pluginProjectionState.stackProps.at(-1);
    expect(stackProps?.pluginUiProjection).toBeNull();
    expect(stackProps?.projectionInteractionEnabled).toBe(false);
    expect(stackProps?.machineId).toBe('machine-pane-driver');
    expect(stackProps?.serverId).toBe('server-pane-driver');
    expect(pluginProjectionState.scopedInputs).toContainEqual({
      machineId: null,
      serverId: null,
      enabled: false,
    });
  });

  it('is the single fix-point: the three Services views delegate to it instead of re-declaring the wiring', () => {
    const repoRoot = path.resolve(__dirname, '../../../..');
    const viewPaths = [
      'sources/components/sessions/panes/services/SessionRightPanelServicesView.tsx',
      'sources/components/projects/detail/services/ProjectRightPanelServicesView.tsx',
      'sources/components/workspaceCockpit/session/SessionServicesSurfaceScreen.tsx',
    ];

    for (const relPath of viewPaths) {
      const source = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
      expect(source).toContain('LocalServicesSurfaceHost');
      expect(source).not.toContain('createDefaultRuntimeActionExecutor');
      expect(source).not.toContain('createLocalServiceInventoryState');
    }
  });
  it('shows a service that starts after mount, by re-reading the launcher feed the inventory watch reported changed', async () => {
    // The regression this pins: the pane's rows are built from LAUNCH TARGETS, and inventory
    // entries only enrich them. Making the inventory fresh while leaving the launcher feed on
    // its mount-time read renders nothing new, which a store-level assertion cannot see.
    const startedTarget: LocalServiceLaunchTarget = {
      ...openableTarget,
      id: 'inventory:vite-5199',
      source: 'inventory_entry',
      title: 'Vite dev server',
      subtitle: '127.0.0.1:5199',
      browserTarget: {
        kind: 'localServicePreview',
        targetId: 'preview-vite-5199',
        sessionId: 'session-a',
        machineId: 'machine-a',
      },
    };
    const inventorySnapshotAt = (
      generatedAt: number,
      entries: readonly unknown[],
    ) => ({
      v: 1 as const,
      machineId: 'machine-a',
      generatedAt,
      refreshState: 'idle' as const,
      entries: entries as never,
      diagnostics: [],
    });

    const inventorySnapshotClient = vi.fn(async () => ({
      ok: true as const,
      snapshot: inventorySnapshotAt(1_000, []),
    }));
    let launcherReads = 0;
    const launcherSnapshotClient = vi.fn(async () => {
      launcherReads += 1;
      return {
        ok: true as const,
        snapshot: {
          v: 1 as const,
          machineId: 'machine-a',
          sessionId: 'session-a',
          updatedAt: 3_000 + launcherReads,
          // The daemon only knows about the new service from the scan that just ran.
          targets: launcherReads > 1 ? [startedTarget] : [],
        },
      };
    });

    let answerWatch: ((result: unknown) => void) | null = null;
    const watchSpy = vi
      .spyOn(
        inventoryMachineRpc,
        'watchLocalServiceInventorySnapshotViaMachineRpc',
      )
      .mockImplementation(
        async () =>
          (await new Promise((resolve) => {
            answerWatch = resolve as (result: unknown) => void;
          })) as never,
      );

    const screen = await renderScreen(
      <LocalServicesSurfaceHost
        machineId="machine-a"
        serverId="server-a"
        sessionId="session-a"
        inventorySnapshotClient={inventorySnapshotClient as never}
        launcherSnapshotClient={launcherSnapshotClient as never}
        testID="surface-host-services"
      />,
    );
    await flushHookEffects({ cycles: 3, turns: 3 });
    expect(
      screen.findAllByTestId('surface-host-services-row:inventory:vite-5199'),
    ).toHaveLength(0);
    expect(answerWatch).toBeTypeOf('function');

    // The dev server starts; the daemon answers the parked watch with the newer snapshot.
    await act(async () => {
      answerWatch?.({
        ok: true,
        changed: true,
        snapshot: inventorySnapshotAt(2_000, []),
      });
      await Promise.resolve();
    });
    await flushHookEffects({ cycles: 4, turns: 4 });

    expect(launcherSnapshotClient.mock.calls.length).toBeGreaterThan(1);
    expect(
      screen.findByTestId('surface-host-services-row:inventory:vite-5199'),
    ).toBeTruthy();
    watchSpy.mockRestore();
  });
});
