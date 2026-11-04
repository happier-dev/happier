import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  MachineReachabilityObservationV1Schema,
  MachineReachabilityPlanV1Schema,
  MachineReachabilityPostureV1Schema,
} from '@happier-dev/protocol';

import { findTestInstanceByTypeWithProps, renderScreen } from '@/dev/testkit';
import { installMachinesSettingsCommonModuleMocks } from '@/components/settings/machines/machinesSettingsTestHelpers';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { HappierRadioMark } from '@happier-dev/plugin-ui/presentation';

import {
  presentMachineNetwork,
  type MachineNetworkFacts,
  type MachineNetworkRead,
} from './networkSurface';
import type { MachineNetworkViewModel } from './MachineNetworkSection';
import type { MachineNetworkReview } from './useMachineNetworkReview';

installMachinesSettingsCommonModuleMocks();

const posture = MachineReachabilityPostureV1Schema.parse({
  revision: 3,
  management: {
    providers: [],
    publicSsh: { kind: 'open', port: 22, sourceCidrs: ['0.0.0.0/0'] },
  },
  defaultServiceIngress: { kind: 'none' },
});
const observation = MachineReachabilityObservationV1Schema.parse({
  revision: 7,
  management: { daemon: 'ready', providers: [], publicSsh: 'open' },
  privateNetworks: [
    {
      provider: { kind: 'builtin', id: 'tailscale' },
      networkIdentity: 'tail3c1',
      displayName: 'tail3c1',
      dnsName: 'shop-prod.tail3c1.ts.net',
      addresses: ['100.101.7.12', 'fd7a:115c:a1e0::6b01:70c'],
      state: 'ready',
      interfaceName: 'tailscale0',
      sourceRanges: ['100.64.0.0/10'],
      magicDnsEnabled: true,
    },
  ],
  ingress: [],
});
const facts: MachineNetworkFacts = { posture, selections: [], observation };
const plan = MachineReachabilityPlanV1Schema.parse({
  reviewedPlanDigest: 'b'.repeat(64),
  basis: {
    machineId: 'shop-prod',
    installationId: 'installation-a',
    currentSelections: [],
    currentPostureRevision: 3,
    change: {
      kind: 'posture',
      posture: {
        ...posture,
        management: { ...posture.management, publicSsh: { kind: 'closed' } },
      },
    },
    occurrences: [],
    recipePlans: [],
  },
});

function model(
  read: MachineNetworkRead,
  reachable: boolean | null,
  refresh = vi.fn(async () => {}),
): MachineNetworkViewModel {
  return {
    ...presentMachineNetwork({ facts, read, reachable }),
    read,
    approval: null,
    refresh,
  };
}

async function render(
  network: MachineNetworkViewModel,
  online: boolean | null,
  review: MachineNetworkReview = { kind: 'idle' },
  controls: Partial<Record<'onApply' | 'onPrepare', () => void>> = {},
) {
  const { MachineNetworkView } = await import('./MachineNetworkSection');
  const draft =
    review.kind === 'idle'
      ? null
      : plan.basis.change.kind === 'posture'
        ? plan.basis.change.posture
        : null;
  return await renderScreen(
    React.createElement(MachineNetworkView, {
      network,
      machineName: 'shop-prod',
      online,
      controls: {
        review,
        draft,
        onDraft: vi.fn(),
        onPrepare: controls.onPrepare ?? vi.fn(),
        onApply: controls.onApply ?? vi.fn(),
        onCancel: vi.fn(),
        onOpenApproval: vi.fn(),
      },
    }),
  );
}

describe('Machine → Network page', () => {
  it('keeps the last-reported facts at full strength while the Machine is offline, and says so once', async () => {
    const screen = await render(model({ kind: 'settled' }, false), false);
    const line = findTestInstanceByTypeWithProps(screen, SurfaceFreshnessLine, {
      testID: 'machine-network-stale',
    });
    expect(line).toBeTruthy();
    // Offline: the hook cannot read, so the line offers no dead Retry.
    expect(line?.props.action).toBeUndefined();
    expect(
      findTestInstanceByTypeWithProps(screen, Item, {
        testID: 'machine-network-private-tailscale:tail3c1-name',
      })?.props.rightElement?.props.values,
    ).toEqual(['shop-prod.tail3c1.ts.net']);
    expect(
      findTestInstanceByTypeWithProps(screen, Item, {
        testID: 'machine-network-public-ssh',
      }),
    ).toBeTruthy();
  });

  it('offers one Retry that asks the Machine again when a refresh failed while it is reachable', async () => {
    const refresh = vi.fn(async () => {});
    const failure = {
      ok: false as const,
      errorCode: 'machine_unavailable',
      error: 'unavailable',
    };
    const screen = await render(
      model({ kind: 'failed', failure }, true, refresh),
      true,
    );
    const line = findTestInstanceByTypeWithProps(screen, SurfaceFreshnessLine, {
      testID: 'machine-network-refresh-failed',
    });
    expect(
      findTestInstanceByTypeWithProps(screen, Item, {
        testID: 'machine-network-private-tailscale:tail3c1',
      }),
    ).toBeTruthy();
    line?.props.action.onPress();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('cannot Apply a second time while the configure waits for approval', async () => {
    const onApply = vi.fn();
    const approval = {
      artifactId: 'network-approval',
      onExecuted: async () => 'ignored' as const,
    };
    const screen = await render(
      model({ kind: 'settled' }, true),
      true,
      { kind: 'applying', plan, approval },
      { onApply },
    );
    expect(
      findTestInstanceByTypeWithProps(screen, RoundButton, {
        testID: 'machine-network-apply',
      })?.props.disabled,
    ).toBe(true);
    expect(
      screen.root.findAll(
        (node) => node.props?.testID === 'machine-network-approval',
      ).length,
    ).toBeGreaterThan(0);
    const reviewing = await render(
      model({ kind: 'settled' }, true),
      true,
      { kind: 'review', plan },
      { onApply },
    );
    expect(
      findTestInstanceByTypeWithProps(reviewing, RoundButton, {
        testID: 'machine-network-apply',
      })?.props.disabled,
    ).toBe(false);
  });

  it('marks the saved ingress provider chosen and keeps every observed capability with its state', async () => {
    const caddy = { provider: { kind: 'builtin' as const, id: 'caddy' }, config: {}, credentialRefs: [] };
    const withIngress: MachineNetworkFacts = {
      posture: { ...posture, defaultServiceIngress: { kind: 'provider', selection: caddy } },
      selections: [caddy],
      observation: MachineReachabilityObservationV1Schema.parse({ ...observation, ingress: [
        { revision: 7, provider: { kind: 'builtin', id: 'cloudflareNamed' }, exposure: 'public', inboundPorts: [], state: 'needsAuth', remedies: ['authenticate'] },
        { revision: 7, provider: caddy.provider, exposure: 'public', inboundPorts: [], state: 'ready', remedies: [] },
        { revision: 7, provider: { kind: 'builtin', id: 'tailscaleServe' }, exposure: 'privateNetwork', inboundPorts: [], state: 'ready', remedies: [] },
      ] }),
    };
    const read: MachineNetworkRead = { kind: 'settled' };
    const network = { ...presentMachineNetwork({ facts: withIngress, read, reachable: true }), read, approval: null, refresh: vi.fn(async () => {}) };
    const screen = await render(network, true);
    const caddyRow = findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine-network-ingress-caddy' });
    expect(caddyRow?.props.selected).toBe(true);
    expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine-network-ingress-none' })?.props.selected).toBe(false);
    // Every choice draws its radio, and the chosen one reads as chosen (the group counts its real choices).
    const marks = screen.root.findAllByType(HappierRadioMark);
    expect(marks.map((mark) => mark.props.selected)).toEqual([false, true]);
    expect(findTestInstanceByTypeWithProps(screen, ItemGroup, { accessibilityRole: 'radiogroup' })?.props.selectableItemCountOverride).toBe(2);
    // Provider qualifiers come from the contribution title; ids remain selectors only.
    expect(caddyRow?.props.titleQualifier).toBe('Caddy');
    expect(caddyRow?.props.title).not.toBe('caddy');
    const cloudflare = findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine-network-ingress-cloudflareNamed' });
    expect(cloudflare?.props.titleQualifier).toBe('Cloudflare (named tunnel)');
    expect(cloudflare?.props.subtitle).toContain('machineDetailPage.network.needsAuth');
    expect(cloudflare?.props.onPress).toBeUndefined();
    expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine-network-ingress-tailscaleServe' })?.props.titleQualifier).toBe('Tailscale Serve');
  });

  it('states Nothing public without a radio when the Machine offers no other way to publish services', async () => {
    const screen = await render(model({ kind: 'settled' }, true), true);
    const none = findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine-network-ingress-none' });
    expect(none).toBeTruthy();
    expect(none?.props.accessibilityRole).toBeUndefined();
    expect(screen.root.findAllByType(HappierRadioMark)).toHaveLength(0);
    expect(findTestInstanceByTypeWithProps(screen, ItemGroup, { accessibilityRole: 'radiogroup' })).toBeFalsy();
  });

  it('uses generic text when the catalog cannot name a provider, including unnamed private networks', async () => {
    const unknownProvider = { kind: 'builtin', id: 'missing-internal-provider' };
    const unknown = MachineReachabilityObservationV1Schema.parse({ ...observation,
      management: { ...observation.management, providers: [{ provider: unknownProvider, state: 'ready' }] },
      privateNetworks: [{ ...observation.privateNetworks[0], provider: unknownProvider, networkIdentity: null, displayName: null }],
      ingress: [{ revision: 7, provider: unknownProvider, exposure: 'public', inboundPorts: [], state: 'ready', remedies: [] }],
    });
    const network = model({ kind: 'settled' }, true);
    const screen = await render({ ...network, facts: { ...network.facts, observation: unknown } }, true);
    expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine-network-manage-missing-internal-provider' })?.props.titleQualifier)
      .toBe('machineDetailPage.network.anotherWayIn');
    expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine-network-ingress-missing-internal-provider' })?.props.titleQualifier)
      .toBe('machineDetailPage.network.anotherWayIn');
    expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine-network-private-missing-internal-provider:shop-prod.tail3c1.ts.net' })?.props.title)
      .toBe('machineDetailPage.network.privateTitle');
  });

  it('names management providers and the host-reviewed ingress from the same catalog', async () => {
    const { MachineNetworkView } = await import('./MachineNetworkSection');
    const network = model({ kind: 'settled' }, true);
    const withManagement = MachineReachabilityObservationV1Schema.parse({ ...observation,
      management: { ...observation.management, providers: [{ provider: { kind: 'builtin', id: 'tailscale' }, state: 'ready' }] },
    });
    const reviewed = MachineReachabilityPlanV1Schema.parse({ ...plan, basis: { ...plan.basis,
      change: { kind: 'posture', posture: { ...posture,
        defaultServiceIngress: { kind: 'provider', selection: { provider: { kind: 'builtin', id: 'caddy' }, config: {}, credentialRefs: [] } },
      } },
    } });
    const screen = await renderScreen(React.createElement(MachineNetworkView, {
      network: { ...network, facts: { ...network.facts, observation: withManagement } }, machineName: 'shop-prod', online: true,
      controls: { review: { kind: 'review', plan: reviewed }, draft: null, onDraft: vi.fn(), onPrepare: vi.fn(), onApply: vi.fn(), onCancel: vi.fn(), onOpenApproval: vi.fn() },
    }));
    expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine-network-manage-tailscale' })?.props.titleQualifier).toBe('Tailscale');
    expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine-network-change-ingress' })?.props.detail).toBe('Caddy');
  });

  it('lists the change the host planned, not the local draft', async () => {
    const { MachineNetworkView } = await import('./MachineNetworkSection');
    const screen = await renderScreen(
      React.createElement(MachineNetworkView, {
        network: model({ kind: 'settled' }, true),
        machineName: 'shop-prod',
        online: true,
        controls: {
          review: { kind: 'review', plan },
          draft: null,
          onDraft: vi.fn(),
          onPrepare: vi.fn(),
          onApply: vi.fn(),
          onCancel: vi.fn(),
          onOpenApproval: vi.fn(),
        },
      }),
    );
    expect(
      findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine-network-change-public-ssh' })?.props.detail,
    ).toBe('machineDetailPage.network.off');
  });

  it('states an unsaved SSH choice without reporting the Machine as disagreeing with it', async () => {
    const { MachineNetworkView } = await import('./MachineNetworkSection');
    const draft = plan.basis.change.kind === 'posture' ? plan.basis.change.posture : null;
    const screen = await renderScreen(
      React.createElement(MachineNetworkView, {
        network: model({ kind: 'settled' }, true),
        machineName: 'shop-prod',
        online: true,
        controls: {
          review: { kind: 'idle' }, draft, onDraft: vi.fn(), onPrepare: vi.fn(),
          onApply: vi.fn(), onCancel: vi.fn(), onOpenApproval: vi.fn(),
        },
      }),
    );
    // Saved open and observed open agree; the draft (closed) is the person's pending choice, not a mismatch.
    expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine-network-public-ssh' })?.props.subtitle)
      .toBe('machineDetailPage.network.publicSshClosed');
  });

  it('says when the Machine last answered beside the Happier way in, and nothing when it never has', async () => {
    const answered = await render({
      ...model({ kind: 'settled' }, true),
      facts: { ...facts, lastAnsweredAtMs: Date.UTC(2026, 9, 21, 10, 42) },
    }, true);
    expect(findTestInstanceByTypeWithProps(answered, Item, { testID: 'machine-network-happier' })?.props.detail)
      .toBe('machineDetailPage.network.daemonReady · machineDetailPage.network.answeredAt');
    const never = await render({ ...model({ kind: 'settled' }, true), facts: { ...facts, lastAnsweredAtMs: null } }, true);
    expect(findTestInstanceByTypeWithProps(never, Item, { testID: 'machine-network-happier' })?.props.detail)
      .toBe('machineDetailPage.network.daemonReady');
  });

  it('names a private network by its own name, then its provider and state, with each address as its own value', async () => {
    const screen = await render(model({ kind: 'settled' }, true), true);
    const row = findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine-network-private-tailscale:tail3c1' });
    expect(row?.props.title).toBe('tail3c1');
    expect(row?.props.subtitle).toBe('Tailscale · machineDetailPage.network.on');
    const addresses = findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine-network-private-tailscale:tail3c1-addresses' });
    expect(addresses?.props.rightElement?.props.values).toEqual(['100.101.7.12', 'fd7a:115c:a1e0::6b01:70c']);
  });


});
