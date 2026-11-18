import * as React from 'react';
import {
  createDeploymentReadControllerV1,
  type DeploymentReadTransportV1,
} from '@happier-dev/deployments';
import type { DeploymentReceiptHeaderV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import {
  createDeploymentEnvironmentHeaderV1,
  createDeploymentReceiptHeaderV1,
} from '@happier-dev/deployment-protocol/testing/v1';

import { AllDeploymentsView } from '@/components/projects/deployments/AllDeploymentsScreen';
import { useDeploymentCollection } from '@/components/projects/deployments/useDeploymentReads';
import { useAllMachines } from '@/sync/store/hooks';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { projectPluginPortableUiDeclarationsV1 } from '@happier-dev/protocol/plugins/contributions/ui/declarationProjection';
import { normalizePluginInstalledUiDeclarations } from '@/sync/domains/plugins/ui/projection';
import {
  AppShellPluginUiProjectionValueProvider,
  useAppShellPluginUiProjectionCurrentness,
  type AppShellPluginUiProjectionValue,
} from '@/components/appShell/plugins/AppShellPluginUiProjection';
import telemetryManifest from '../../../../../cli/assets/bundled-plugin-manifests/telemetry.json';

/**
 * Dev-only specimen of Projects → All deployments over a fixture network boundary, drawn through the real page
 * and its real read hook. `?state=populated|loading|empty|partial|paged|error|denied|stale`. Project names and
 * live titles come from the read, as the producer carries them; the Machine is the signed-in Account's own.
 */
const HOUR = 3_600_000;
const NOW = Date.now();
const SHOWN = Object.freeze({ mounted: true, visible: true, focused: true });
type ReceiptState = DeploymentReceiptHeaderV1['state'];

const STEPS_RUNNING = [
  { id: 'sync', label: 'Sync', state: 'succeeded' as const, durationMs: 4_000 },
  { id: 'build', label: 'Build', state: 'running' as const },
  { id: 'migrate', label: 'Migrate', state: 'pending' as const },
  { id: 'rollout', label: 'Roll out', state: 'pending' as const },
  { id: 'route', label: 'Route', state: 'pending' as const },
];

/** Admitted Source names as the read carries them; `source-gone` is one whose name is unavailable. */
const SOURCE_NAMES: Record<string, string> = { 'source-shop': 'storefront', 'source-api': 'payments-api', 'source-docs': 'docs-site' };

function row(
  input: Readonly<{
    id: string;
    sourceId: string;
    title: string;
    machineId: string;
    ageHours: number;
    production?: boolean;
    state?: ReceiptState;
    steps?: typeof STEPS_RUNNING;
    live?: string;
  }>,
) {
  return {
    environment: createDeploymentEnvironmentHeaderV1({
      id: input.id,
      projectSourceId: input.sourceId,
      controllerMachineId: input.machineId,
      protection: input.production ? 'production' : 'nonProduction',
      updatedAtMs: NOW - input.ageHours * HOUR,
    }),
    title: input.title,
    projectSourceName: SOURCE_NAMES[input.sourceId] ?? null,
    liveVersionTitle: input.live ?? null,
    currentDeployment: input.state
      ? {
          ...createDeploymentReceiptHeaderV1({
            id: `${input.id}-receipt`,
            environmentId: input.id,
            state: input.state,
            requestedAtMs: NOW - input.ageHours * HOUR,
          startedAtMs: NOW - input.ageHours * HOUR + 1_000,
          settledAtMs: input.state === 'running' || input.state === 'queued' ? undefined : NOW - input.ageHours * HOUR + 60_000,
          }),
          ...(input.steps ? { steps: input.steps } : {}),
        }
      : null,
  };
}

function transportFor(state: string, machineId: string): DeploymentReadTransportV1 {
  const [a, b, c] = ['source-shop', 'source-api', 'source-docs'];
  const first = [
    row({
      id: 'env-shop-production',
      sourceId: a,
      title: 'Production',
      machineId,
      ageHours: 0.1,
      production: true,
      state: 'running',
      steps: STEPS_RUNNING,
    }),
    row({
      id: 'env-shop-staging',
      sourceId: a,
      title: 'Staging',
      machineId,
      ageHours: 3,
      state: 'succeeded',
      live: 'feat(cart): keep the cart after sign-in',
    }),
    row({
      id: 'env-api-production',
      sourceId: b,
      title: 'Production API',
      machineId,
      ageHours: 0.6,
      production: true,
      state: 'failed',
    }),
    row({
      id: 'env-api-preview',
      sourceId: b,
      title: 'Preview · checkout-v2',
      machineId,
      ageHours: 26,
      state: 'running_unverified',
    }),
    row({
      id: 'env-docs-site',
      sourceId: c,
      title: 'Docs site',
      machineId,
      ageHours: 52,
      state: 'succeeded',
      live: 'docs: deploy guide for own servers',
    }),
  ];
  const later = [
    row({
      id: 'env-docs-staging',
      sourceId: 'source-gone',
      title: 'Docs staging',
      machineId,
      ageHours: 120,
    }),
  ];
  let reads = 0;
  const never = new Promise<never>(() => {});
  const fail = (code: string, retryable: boolean) => ({
    ok: false as const,
    failure: { code, retryable },
  });
  const unavailable = async () => fail('deployment_unavailable', true);
  return {
    listEnvironments: async (_scope, query) => {
      reads += 1;
      if (state === 'loading') return never;
      if (state === 'error') return fail('home_unreachable', true);
      if (state === 'denied') return fail('access_denied', false);
      if (state === 'stale' && reads > 1) return fail('home_unreachable', true);
      if (state === 'empty')
        return {
          ok: true,
          value: { items: [], nextCursor: null, coverage: 'complete' },
        };
      if (state === 'partial')
        return query.cursor
          ? { ok: true, value: { items: later, nextCursor: null } }
          : {
              ok: true,
              value: {
                items: [],
                nextCursor: 'env-hidden',
                coverage: 'partial',
              },
            };
      if (state === 'paged')
        return query.cursor
          ? { ok: true, value: { items: later, nextCursor: null } }
          : { ok: true, value: { items: first, nextCursor: 'env-docs-site' } };
      return {
        ok: true,
        value: { items: first, nextCursor: null, coverage: 'complete' },
      };
    },
    readEnvironment: unavailable,
    listHistory: unavailable,
    readReceipt: unavailable,
  };
}

/** Cold bundled metadata only: without an installed collector, selected Requests stays unknown. */
function RequestsColumnSpecimen(props: Readonly<{ children: React.ReactNode }>) {
  const current = useAppShellPluginUiProjectionCurrentness();
  const value = React.useMemo(() => {
    const manifest = PluginManifestV2Schema.parse(telemetryManifest);
    return ({
      pluginUiProjection: normalizePluginInstalledUiDeclarations(projectPluginPortableUiDeclarationsV1(manifest), undefined, {
        id: manifest.id, displayName: manifest.displayName, version: manifest.version, enabled: true,
        source: { kind: 'bundled' as const, locator: manifest.id },
      }),
      pluginBrowserProjection: null,
      phase: 'current',
      interactionEnabled: false,
      machineId: current.machineId,
      serverId: current.serverId,
      platform: current.platform,
      accountLifetime: current.accountLifetime,
      clientExecutableActivation: { status: 'ready' },
      reloadConnectedAccountProjection() {},
      reloadClientExecutables() {},
    } satisfies AppShellPluginUiProjectionValue);
  }, [current.machineId, current.serverId, current.platform, current.accountLifetime]);
  return <AppShellPluginUiProjectionValueProvider value={value}>{props.children}</AppShellPluginUiProjectionValueProvider>;
}

export function AllDeploymentsSpecimen(props: Readonly<{ state: string; requestsColumn?: boolean }>) {
  const serverId = 'home';
  const machineId = useAllMachines(
    (machines) => machines[0]?.id ?? 'machine-specimen',
  );
  const controller = React.useMemo(
    () =>
      createDeploymentReadControllerV1({
        scope: { serverId: 'home', accountId: 'account-owner' },
        transport: transportFor(props.state, machineId),
      }),
    [props.state, machineId],
  );
  React.useEffect(() => () => controller.retire(), [controller]);
  const read = useDeploymentCollection(controller, SHOWN);
  // `stale`: the first page landed, then a refresh found the Home not answering.
  const ready = read.snapshot.status === 'ready';
  const { refresh } = read;
  React.useEffect(() => {
    if (props.state === 'stale' && ready) void refresh();
  }, [props.state, ready, refresh]);
  const body = <AllDeploymentsView read={read} serverId={serverId} />;
  return props.requestsColumn ? <RequestsColumnSpecimen>{body}</RequestsColumnSpecimen> : body;
}
