import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  MachineReachabilityObservationV1Schema,
  MachineReachabilityPlanV1Schema,
  MachineReachabilityPostureV1Schema,
  type MachineReachabilityPostureV1,
} from '@happier-dev/protocol';

import { findTestInstanceByTypeWithProps, renderScreen } from '@/dev/testkit';
import { installMachinesSettingsCommonModuleMocks } from '@/components/settings/machines/machinesSettingsTestHelpers';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { HappierRadioMark } from '@happier-dev/plugin-ui/presentation';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { MachinePagePinnedBarContext, createMachinePagePinnedBarSlot } from '@/components/machines/page/machinePagePinnedBar';

import {
  presentMachineNetwork,
  type MachineNetworkFacts,
  type MachineNetworkRead,
} from './networkSurface';
import type { MachineNetworkExposureFacts } from './networkExposureFacts';
import { projectMachineNetworkAccessFacts } from './networkAccessFacts';
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
  controls: Partial<Record<'onApply' | 'onPrepare' | 'onCancel', () => void> & {
    onPrepareChange: (change: unknown) => void;
    onDraft: (next: MachineReachabilityPostureV1 | null) => void;
  }> = {},
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
        onDraft: controls.onDraft ?? vi.fn(),
        onPrepare: controls.onPrepare ?? vi.fn(),
        onPrepareChange: controls.onPrepareChange ?? vi.fn(),
        onApply: controls.onApply ?? vi.fn(),
        onCancel: controls.onCancel ?? vi.fn(),
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

  it('warns before closing SSH without independent recovery and can keep saved SSH without applying', async () => {
    const saved = MachineReachabilityPostureV1Schema.parse({
      ...posture,
      management: { ...posture.management, publicSsh: { kind: 'open', port: 2222, sourceCidrs: ['192.0.2.0/24'] } },
    });
    const proposed = MachineReachabilityPostureV1Schema.parse({
      ...(plan.basis.change.kind === 'posture' ? plan.basis.change.posture : posture),
      revision: saved.revision + 1,
      defaultServiceIngress: { kind: 'provider', selection: { provider: { kind: 'builtin', id: 'caddy' }, config: {}, credentialRefs: [] } },
    });
    const reviewed = MachineReachabilityPlanV1Schema.parse({
      ...plan, basis: { ...plan.basis, change: { kind: 'posture', posture: proposed } },
    });
    const onDraft = vi.fn();
    const onCancel = vi.fn();
    const onApply = vi.fn();
    const screen = await render(
      { ...model({ kind: 'settled' }, true), facts: { ...facts, posture: saved } },
      true,
      { kind: 'review', plan: reviewed },
      { onDraft, onCancel, onApply },
    );
    const warning = findTestInstanceByTypeWithProps(screen, AttentionBanner, {
      testID: 'machine-network-ssh-recovery-warning',
    });
    // Amber, announced, and it carries the way out itself (lab reachability/closeonly).
    expect(warning?.props.tone).toBe('warning');
    expect(warning?.props.announce).toBe('alert');
    expect(findTestInstanceByTypeWithProps(screen, RoundButton, {
      testID: 'machine-network-apply',
    })?.props.disabled).toBe(false);
    const keep = findTestInstanceByTypeWithProps(screen, RoundButton, {
      testID: 'machine-network-keep-ssh',
    });
    expect(keep).toBeTruthy();
    screen.pressByTestId('machine-network-keep-ssh');
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onDraft).toHaveBeenCalledWith({
      ...proposed, revision: saved.revision, management: { ...proposed.management, publicSsh: saved.management.publicSsh },
    });
    expect(onApply).not.toHaveBeenCalled();
  });

  it('uses the reviewed recovery and SSH choice rather than an unreviewed local draft for the warning', async () => {
    const recovered = MachineReachabilityPostureV1Schema.parse({
      ...posture,
      management: { ...posture.management, publicSsh: { kind: 'closed' }, independentRecovery: { kind: 'providerConsole', evidence: 'userAttested' } },
    });
    for (const proposed of [posture, recovered]) {
      const reviewed = MachineReachabilityPlanV1Schema.parse({
        ...plan, basis: { ...plan.basis, change: { kind: 'posture', posture: proposed } },
      });
      const screen = await render(model({ kind: 'settled' }, true), true, { kind: 'review', plan: reviewed });
      expect(findTestInstanceByTypeWithProps(screen, AttentionBanner, {
        testID: 'machine-network-ssh-recovery-warning',
      })).toBeUndefined();
      expect(findTestInstanceByTypeWithProps(screen, RoundButton, {
        testID: 'machine-network-keep-ssh',
      })).toBeUndefined();
      expect(findTestInstanceByTypeWithProps(screen, RoundButton, {
        testID: 'machine-network-cancel',
      })).toBeTruthy();
    }
  });

  it('names and warns about the reviewed native SSH closure when saved metadata already says closed', async () => {
    const closed = MachineReachabilityPostureV1Schema.parse({
      ...posture, management: { ...posture.management, publicSsh: { kind: 'closed' } },
    });
    const reviewed = MachineReachabilityPlanV1Schema.parse({
      ...plan,
      basis: {
        ...plan.basis,
        change: { kind: 'posture', posture: closed },
        nativeFirewall: {
          status: 'available', ownedTable: 'present', externalInterfaces: ['eth0'], privateInterfaces: [],
          retainedSshEndpoints: [{ interfaceName: 'eth0', hostAddress: '203.0.113.12', port: 2222, sourceCidrs: ['0.0.0.0/0'] }],
        },
        firewallTransition: { setupRevision: 4, dockerEngineIds: [], intent: { v: 1, kind: 'retainSsh', caddy: {}, publicSsh: { kind: 'closed' } } },
      },
    });
    const onDraft = vi.fn();
    const onCancel = vi.fn();
    const onApply = vi.fn();
    const screen = await render(
      { ...model({ kind: 'settled' }, true), facts: { ...facts, posture: closed } },
      true,
      { kind: 'review', plan: reviewed },
      { onDraft, onCancel, onApply },
    );
    expect(findTestInstanceByTypeWithProps(screen, Item, {
      testID: 'machine-network-change-public-ssh',
    })?.props.detail).toBe('machineDetailPage.network.off');
    expect(findTestInstanceByTypeWithProps(screen, AttentionBanner, {
      testID: 'machine-network-ssh-recovery-warning',
    })?.props.tone).toBe('warning');
    screen.pressByTestId('machine-network-keep-ssh');
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onDraft).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
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
    // Provider titles come from the contribution title; ids remain selectors only.
    expect(caddyRow?.props.title).toBe('Caddy');
    const cloudflare = findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine-network-ingress-cloudflareNamed' });
    expect(cloudflare?.props.title).toBe('Cloudflare (named tunnel)');
    expect(cloudflare?.props.subtitle).toContain('machineDetailPage.network.needsAuth');
    expect(cloudflare?.props.onPress).toBeUndefined();
    expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine-network-ingress-tailscaleServe' })?.props.title).toBe('Tailscale Serve');
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
    expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine-network-ingress-missing-internal-provider' })?.props.title)
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
      controls: { review: { kind: 'review', plan: reviewed }, draft: null, onDraft: vi.fn(), onPrepare: vi.fn(), onPrepareChange: vi.fn(), onApply: vi.fn(), onCancel: vi.fn(), onOpenApproval: vi.fn() },
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
          onPrepare: vi.fn(), onPrepareChange: vi.fn(),
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

  it('labels staged SSH closure as pending while the observed Machine remains open', async () => {
    const { MachineNetworkView } = await import('./MachineNetworkSection');
    const draft = plan.basis.change.kind === 'posture' ? plan.basis.change.posture : null;
    const screen = await renderScreen(
      React.createElement(MachineNetworkView, {
        network: model({ kind: 'settled' }, true),
        machineName: 'shop-prod',
        online: true,
        controls: {
          review: { kind: 'idle' }, draft, onDraft: vi.fn(), onPrepare: vi.fn(), onPrepareChange: vi.fn(),
          onApply: vi.fn(), onCancel: vi.fn(), onOpenApproval: vi.fn(),
        },
      }),
    );
    // Saved open and observed open agree; the draft (closed) is the person's pending choice, not a mismatch.
    expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine-network-public-ssh' })?.props.subtitle)
      .toBe('machineDetailPage.network.publicSshWillClose');
  });

  it.each(['plan_changed', 'machine_unavailable'])('gives a readable prepare failure and refresh remedy for %s without retrying the same draft', async errorCode => {
    const refresh = vi.fn(async () => {});
    const onCancel = vi.fn();
    const onDraft = vi.fn();
    const onPrepare = vi.fn();
    const screen = await render(model({ kind: 'settled' }, true, refresh), true,
      { kind: 'failed', plan: null, failure: { ok: false, errorCode, error: errorCode } },
      { onCancel, onDraft, onPrepare });
    const card = findTestInstanceByTypeWithProps(screen, SurfaceStateCard, { testID: 'machine-network-review-failed' });
    expect(card?.props.reason).toBe(errorCode === 'plan_changed'
      ? 'machineDetailPage.network.planChanged' : 'machineDetailPage.network.prepareRecovery');
    expect(card?.props.diagnosticCode).toBeUndefined();
    expect(card?.props.action.label).toBe('common.refresh');
    await card?.props.action.onPress();
    if (errorCode === 'plan_changed') expect(onDraft).toHaveBeenCalledWith(null);
    else expect(onDraft).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
    expect(onPrepare).not.toHaveBeenCalled();
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

  it('groups the ports the exposure owner reports by who reaches them, and says what it has not read', async () => {
    const exposure: MachineNetworkExposureFacts = {
      domains: null, services: null,
      ports: [
        { audience: 'internet', hostAddress: '203.0.113.7', port: 2205, protocol: 'tcp', interfaceName: 'eth0', sourceCidrs: ['0.0.0.0/0'] },
        { audience: 'privateNetwork', hostAddress: '100.101.7.12', port: 5432, protocol: 'tcp', serviceId: 'svc-db', networkIdentity: 'tail3c1' },
        { audience: 'thisMachine', hostAddress: '127.0.0.1', port: 6379, protocol: 'tcp', serviceId: 'svc-cache' },
        { audience: 'unknown', hostAddress: null, port: 8080, protocol: 'tcp', serviceId: 'svc-web' },
      ],
    };
    const screen = await render({ ...model({ kind: 'settled' }, true), facts: { ...facts, exposure } }, true);
    const row = (audience: string) => findTestInstanceByTypeWithProps(screen, Item, { testID: `machine-network-ports-${audience}` });
    expect(row('internet')?.props.rightElement?.props.ports).toEqual(['2205']);
    expect(row('internet')?.props.subtitle).toBe('machineDetailPage.network.portsSsh');
    expect(row('privateNetwork')?.props.rightElement?.props.ports).toEqual(['5432']);
    expect(row('thisMachine')?.props.rightElement?.props.ports).toEqual(['6379']);
    // A port whose audience the owner could not classify is said so, never filed under a guess.
    expect(row('unknown')?.props.rightElement?.props.ports).toEqual(['8080']);
    // Services and Domains not read yet: one honest row, never an empty list read as "none".
    expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine-network-ports-unread' })).toBeTruthy();

    const read = await render({ ...model({ kind: 'settled' }, true),
      facts: { ...facts, exposure: { domains: [], services: [], ports: [] } } }, true);
    expect(findTestInstanceByTypeWithProps(read, Item, { testID: 'machine-network-ports-unread' })).toBeFalsy();
    expect(findTestInstanceByTypeWithProps(read, Item, { testID: 'machine-network-ports-none' })).toBeTruthy();
  });

  it('offers each produced Join choice to an owner with empty membership and reviews its exact saved profile', async () => {
    const selections = ['work', 'personal'].map(profile => ({
      provider: { kind: 'builtin' as const, id: 'tailscale' }, config: { profile }, credentialRefs: [],
    }));
    const empty = { ...facts, selections, observation: { ...observation, privateNetworks: [] } };
    const network = { ...model({ kind: 'settled' }, true),
      facts: { ...empty, access: projectMachineNetworkAccessFacts(empty) } };
    const onPrepareChange = vi.fn();
    const screen = await render(network, true, { kind: 'idle' }, { onPrepareChange });
    for (const [index, selection] of selections.entries()) {
      const join = findTestInstanceByTypeWithProps(screen, RoundButton, { testID: `machine-network-private-join-${index}` });
      expect(join).toBeTruthy();
      expect(join?.props.disabled).not.toBe(true);
      join?.props.onPress();
      expect(onPrepareChange).toHaveBeenLastCalledWith({ kind: 'privateNetwork', intent: 'join', selection });
    }
    const reviewing = await render(network, true, { kind: 'review', plan });
    expect(findTestInstanceByTypeWithProps(reviewing, RoundButton, { testID: 'machine-network-private-join-0' })?.props.disabled).toBe(true);
  });

  it('offers no Join to a Use member even with published choices and empty membership', async () => {
    const selection = { provider: { kind: 'builtin' as const, id: 'tailscale' }, config: { profile: 'work' }, credentialRefs: [] };
    const empty = { ...facts, selections: [selection], observation: { ...observation, privateNetworks: [] } };
    const read: MachineNetworkRead = { kind: 'unrequested' };
    const network = { ...model(read, true), ...presentMachineNetwork({
      facts: { ...empty, access: projectMachineNetworkAccessFacts(empty) }, read, reachable: true, needsManage: true,
    }) };
    const screen = await render(network, true);
    expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine-network-private-empty' })).toBeTruthy();
    expect(findTestInstanceByTypeWithProps(screen, RoundButton, { testID: 'machine-network-private-join-0' })).toBeFalsy();
  });

  it('offers Leave only for a network whose exact saved selection is known, and reviews that exact change', async () => {
    const selection = { provider: { kind: 'builtin' as const, id: 'tailscale' }, config: { profile: 'work' }, credentialRefs: [] };
    const onPrepareChange = vi.fn();
    const withSelection = await render({ ...model({ kind: 'settled' }, true), facts: { ...facts, selections: [selection] } }, true,
      { kind: 'idle' }, { onPrepareChange });
    const leave = findTestInstanceByTypeWithProps(withSelection, RoundButton, { testID: 'machine-network-private-tailscale:tail3c1-leave' });
    leave?.props.onPress();
    expect(onPrepareChange).toHaveBeenCalledWith({ kind: 'privateNetwork', intent: 'leave', selection });

    const unknown = await render(model({ kind: 'settled' }, true), true);
    expect(findTestInstanceByTypeWithProps(unknown, RoundButton, { testID: 'machine-network-private-tailscale:tail3c1-leave' })).toBeFalsy();
  });

  it('offers Set up for a network that is not on yet, joining with its saved selection', async () => {
    const selection = { provider: { kind: 'builtin' as const, id: 'tailscale' }, config: {}, credentialRefs: [] };
    const stopped = MachineReachabilityObservationV1Schema.parse({ ...observation,
      privateNetworks: observation.privateNetworks.map(network => ({ ...network, state: 'stopped' })) });
    const onPrepareChange = vi.fn();
    const screen = await render({ ...model({ kind: 'settled' }, true), facts: { ...facts, selections: [selection], observation: stopped } }, true,
      { kind: 'idle' }, { onPrepareChange });
    expect(findTestInstanceByTypeWithProps(screen, RoundButton, { testID: 'machine-network-private-tailscale:tail3c1-leave' })).toBeFalsy();
    findTestInstanceByTypeWithProps(screen, RoundButton, { testID: 'machine-network-private-tailscale:tail3c1-join' })?.props.onPress();
    expect(onPrepareChange).toHaveBeenCalledWith({ kind: 'privateNetwork', intent: 'join', selection });
  });

  it('dates a confirmed console, and lets the person confirm it through the reviewed change', async () => {
    const confirmedAtMs = Date.UTC(2026, 9, 21, 9, 0);
    const confirmed = MachineReachabilityPostureV1Schema.parse({ ...posture, management: { ...posture.management,
      independentRecovery: { kind: 'providerConsole', evidence: 'userAttested', confirmedAtMs } } });
    const dated = await render({ ...model({ kind: 'settled' }, true), facts: { ...facts, posture: confirmed } }, true);
    expect(findTestInstanceByTypeWithProps(dated, Item, { testID: 'machine-network-recovery' })?.props.subtitle)
      .toBe('machineDetailPage.network.recoveryConsole · machineDetailPage.network.recoveryConfirmedOn');

    const onPrepareChange = vi.fn();
    const unset = await render(model({ kind: 'settled' }, true), true, { kind: 'idle' }, { onPrepareChange });
    findTestInstanceByTypeWithProps(unset, RoundButton, { testID: 'machine-network-recovery-confirm' })?.props.onPress();
    const change = onPrepareChange.mock.calls[0]?.[0];
    expect(change?.kind).toBe('posture');
    expect(change?.posture.management.independentRecovery).toMatchObject({ kind: 'providerConsole', evidence: 'userAttested' });
  });

  it('names a private-network change in the review card', async () => {
    const selection = { provider: { kind: 'builtin' as const, id: 'tailscale' }, config: {}, credentialRefs: [] };
    const leavePlan = MachineReachabilityPlanV1Schema.parse({ ...plan, basis: { ...plan.basis, currentSelections: [selection],
      change: { kind: 'privateNetwork', intent: 'leave', selection } } });
    const screen = await render(model({ kind: 'settled' }, true), true, { kind: 'review', plan: leavePlan });
    expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine-network-change-private-network' })?.props.detail)
      .toBe('machineDetailPage.network.leaveNetwork');
  });

  it('tells a Use grantee that Network needs Manage, with no retry and no stale facts', async () => {
    const read: MachineNetworkRead = { kind: 'unrequested' };
    const network: MachineNetworkViewModel = {
      ...presentMachineNetwork({ facts: { posture: null, selections: null, observation: null }, read, reachable: true, needsManage: true }),
      read, approval: null, refresh: vi.fn(async () => {}),
    } satisfies MachineNetworkViewModel;
    const screen = await render(network, true);
    const card = findTestInstanceByTypeWithProps(screen, SurfaceStateCard, { testID: 'machine-network-needs-manage' });
    expect(card?.props.kind).toBe('denied');
    expect(card?.props.action).toBeUndefined();
    expect(findTestInstanceByTypeWithProps(screen, SurfaceStateCard, { testID: 'machine-network-unavailable' })).toBeFalsy();
  });

  it('keeps facts already published to a Use grantee above the needs-Manage card, read-only and naming the owner', async () => {
    const selection = { provider: { kind: 'builtin' as const, id: 'tailscale' }, config: {}, credentialRefs: [] };
    const read: MachineNetworkRead = { kind: 'unrequested' };
    const published = { ...facts, selections: [selection] };
    const network = {
      ...presentMachineNetwork({ facts: published, read, reachable: true, needsManage: true }),
      read, approval: null, refresh: vi.fn(async () => {}),
    } satisfies MachineNetworkViewModel;
    const { MachineNetworkView } = await import('./MachineNetworkSection');
    const screen = await renderScreen(React.createElement(MachineNetworkView, {
      network, machineName: 'shop-prod', online: true, ownerName: 'Mara',
      controls: { review: { kind: 'idle' }, draft: null, onDraft: vi.fn(), onPrepare: vi.fn(), onPrepareChange: vi.fn(),
        onApply: vi.fn(), onCancel: vi.fn(), onOpenApproval: vi.fn() },
    }));
    expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine-network-private-tailscale:tail3c1' })).toBeTruthy();
    expect(findTestInstanceByTypeWithProps(screen, RoundButton, { testID: 'machine-network-private-tailscale:tail3c1-leave' })).toBeFalsy();
    // With facts on screen, one quiet line under the headline explains the read-only page; no hero under it.
    expect(findTestInstanceByTypeWithProps(screen, SurfaceStateCard, { testID: 'machine-network-needs-manage' })).toBeFalsy();
    const line = findTestInstanceByTypeWithProps(screen, SurfaceFreshnessLine, { testID: 'machine-network-needs-manage-line' });
    expect(line?.props.reason).toBe('machineDetailPage.network.needsManageLineAskOwner');
    expect(line?.props.action).toBeUndefined();
    // The SSH row states its value; there is no control a Use grantee could mistake for live.
    expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine-network-public-ssh' })?.props.rightElement).toBeUndefined();
  });
});

describe('Machine → Network: how people reach its services and ways in (P-M4)', () => {
  const cloudflare = { provider: { kind: 'builtin' as const, id: 'cloudflareNamed' }, config: { hostname: 'shop.example.com' }, credentialRefs: [] };
  const withCapabilities = (selections: MachineNetworkFacts['selections']): MachineNetworkViewModel => {
    const next: MachineNetworkFacts = { posture, selections, observation: MachineReachabilityObservationV1Schema.parse({ ...observation, ingress: [
      { revision: 7, provider: cloudflare.provider, exposure: 'public', inboundPorts: [], state: 'ready', remedies: [] },
      { revision: 7, provider: { kind: 'builtin', id: 'tailscaleServe' }, exposure: 'privateNetwork', inboundPorts: [], state: 'ready', remedies: [] },
      { revision: 7, provider: { kind: 'builtin', id: 'caddy' }, exposure: 'public', inboundPorts: [{ port: 443, protocol: 'tcp', exposure: 'public' }], state: 'needsSetup', remedies: ['configure'] },
    ] }) };
    const read: MachineNetworkRead = { kind: 'settled' };
    return { ...presentMachineNetwork({ facts: next, read, reachable: true }), read, approval: null, refresh: vi.fn(async () => {}) };
  };

  it('lets the owner choose a ready provider with its one saved configuration, drafting exactly that selection', async () => {
    const onDraft = vi.fn();
    const screen = await render(withCapabilities([cloudflare]), true, { kind: 'idle' }, { onDraft });
    const row = findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine-network-ingress-cloudflareNamed' });
    // The provider names the row; its consequence sits beneath, never a raw id.
    expect(row?.props.title).toBe('Cloudflare (named tunnel)');
    expect(row?.props.subtitle).toBe('machineDetailPage.network.ingressPublicNoPorts');
    expect(row?.props.accessibilityRole).toBe('radio');
    row?.props.onPress();
    // The same posture configure input the host admits (T2-INGRESS 61ca871428).
    expect(onDraft).toHaveBeenCalledWith({ ...posture, defaultServiceIngress: { kind: 'provider', selection: cloudflare } });
    expect(findTestInstanceByTypeWithProps(screen, ItemGroup, { accessibilityRole: 'radiogroup' })?.props.selectableItemCountOverride).toBe(2);
    // A drafted provider reads as chosen.
    const drafted = await renderScreen(React.createElement((await import('./MachineNetworkSection')).MachineNetworkView, {
      network: withCapabilities([cloudflare]), machineName: 'shop-prod', online: true,
      controls: { review: { kind: 'idle' }, draft: { ...posture, defaultServiceIngress: { kind: 'provider', selection: cloudflare } },
        onDraft: vi.fn(), onPrepare: vi.fn(), onPrepareChange: vi.fn(), onApply: vi.fn(), onCancel: vi.fn(), onOpenApproval: vi.fn() },
    }));
    expect(findTestInstanceByTypeWithProps(drafted, Item, { testID: 'machine-network-ingress-cloudflareNamed' })?.props.selected).toBe(true);
    expect(findTestInstanceByTypeWithProps(drafted, Item, { testID: 'machine-network-ingress-none' })?.props.selected).toBe(false);
  });

  it('keeps a provider with no saved selection, or not ready, as information with its reason, never a dead radio', async () => {
    const screen = await render(withCapabilities([cloudflare]), true);
    const serve = findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine-network-ingress-tailscaleServe' });
    expect(serve?.props.title).toBe('Tailscale Serve');
    expect(serve?.props.subtitle).toBe('machineDetailPage.network.exposurePrivate · machineDetailPage.network.ingressNotSetUp');
    expect(serve?.props.onPress).toBeUndefined();
    expect(serve?.props.accessibilityRole).toBeUndefined();
    const caddy = findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine-network-ingress-caddy' });
    expect(caddy?.props.subtitle).toBe('machineDetailPage.network.ingressPublicPorts · machineDetailPage.network.needsSetup');
    expect(caddy?.props.onPress).toBeUndefined();
    // Nothing choosable beyond Nothing public: a statement, not a one-option radio.
    const none = await render(withCapabilities([]), true);
    expect(none.root.findAllByType(HappierRadioMark)).toHaveLength(0);
    expect(findTestInstanceByTypeWithProps(none, Item, { testID: 'machine-network-ingress-cloudflareNamed' })?.props.onPress).toBeUndefined();
  });

  it('offers Add a way in for a configured private network the Machine is not on, through the same reviewed Join', async () => {
    const tailscale = { provider: { kind: 'builtin' as const, id: 'tailscale' }, config: {}, credentialRefs: [] };
    const off = { ...facts, selections: [tailscale], observation: { ...observation, privateNetworks: [] } };
    const network = { ...model({ kind: 'settled' }, true), facts: { ...off, access: projectMachineNetworkAccessFacts(off) } };
    const onPrepareChange = vi.fn();
    // The section header action renders only in page presentation, so the action element is rendered on its own here.
    const manageAction = async (screen: Awaited<ReturnType<typeof render>>) => {
      const action = findTestInstanceByTypeWithProps(screen, ItemGroup, { title: 'machineDetailPage.network.manageTitle' })?.props.action;
      return action ? await renderScreen(action) : null;
    };
    const menuScreen = await manageAction(await render(network, true, { kind: 'idle' }, { onPrepareChange }));
    const menu = menuScreen ? findTestInstanceByTypeWithProps(menuScreen, DropdownMenu, { testID: 'machine-network-add-way-in' }) : null;
    expect(menu?.props.items.map((item: { title: string }) => item.title)).toEqual(['Tailscale']);
    menu?.props.onSelect(menu.props.items[0].id);
    expect(onPrepareChange).toHaveBeenCalledWith({ kind: 'privateNetwork', intent: 'join', selection: tailscale });
    // Already on that network, or a change already under review: nothing to add.
    const on = { ...facts, selections: [tailscale] };
    expect(await manageAction(await render({ ...model({ kind: 'settled' }, true), facts: { ...on, access: projectMachineNetworkAccessFacts(on) } }, true))).toBeNull();
    expect(await manageAction(await render(network, true, { kind: 'review', plan }))).toBeNull();
  });

  it('says a failed apply was rolled back and verified, from the firewall owner\'s closed result', async () => {
    const absent = { kind: 'absent' as const };
    const recovery = { rules: absent, unit: absent, table: null, boot: { present: true, enabled: true, running: true } };
    const failure = { ok: false as const, errorCode: 'native_effect_failed', error: 'native_effect_failed',
      details: { status: 'rolledBack', recovery, restoration: { status: 'verified', recovery }, remedy: 'Check nftables.' } };
    const screen = await render(model({ kind: 'settled' }, true), true, { kind: 'failed', failure, plan });
    const card = findTestInstanceByTypeWithProps(screen, SurfaceStateCard, { testID: 'machine-network-review-failed' });
    expect(card?.props.reason).toBe('machineDetailPage.network.rolledBack');
    // Without a verified restoration the page never promises the Machine is back as it was.
    const unverified = await render(model({ kind: 'settled' }, true), true,
      { kind: 'failed', failure: { ...failure, details: { status: 'rolledBack', remedy: 'Check nftables.' } }, plan });
    expect(findTestInstanceByTypeWithProps(unverified, SurfaceStateCard, { testID: 'machine-network-review-failed' })?.props.reason)
      .toBe('machineDetailPage.network.applyRecovery');
  });

  it('names a refused provider default in words and keeps the choice to pick another', async () => {
    const onDraft = vi.fn();
    const screen = await render(model({ kind: 'settled' }, true), true,
      { kind: 'failed', plan: null, failure: { ok: false, errorCode: 'access_provider_unavailable', error: 'access_provider_unavailable' } },
      { onDraft });
    const card = findTestInstanceByTypeWithProps(screen, SurfaceStateCard, { testID: 'machine-network-review-failed' });
    expect(card?.props.reason).toBe('machineDetailPage.network.providerRefused');
    await card?.props.action.onPress();
    expect(onDraft).not.toHaveBeenCalled();
  });

  it('reviews closing SSH as the lab does: what Happier checked, the ways in afterwards, and a primary that names the action', async () => {
    const managed = MachineReachabilityObservationV1Schema.parse({ ...observation,
      management: { ...observation.management, providers: [{ provider: { kind: 'builtin', id: 'tailscale' }, state: 'ready' }] } });
    const network = { ...model({ kind: 'settled' }, true), facts: { ...facts, observation: managed, lastAnsweredAtMs: 1_700_000_000_000 } };
    const screen = await render(network, true, { kind: 'review', plan });
    expect(findTestInstanceByTypeWithProps(screen, ItemGroup, { testID: 'machine-network-review-card' })?.props.title)
      .toBe('machineDetailPage.network.reviewTitleCloseSsh');
    expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine-network-checked-happier' })?.props.detail)
      .toBe('machineDetailPage.network.answeredAt');
    expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine-network-checked-other-way' })?.props.detail).toBe('Tailscale');
    expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine-network-ways-in-after' })?.props.detail)
      .toContain('Tailscale');
    expect(findTestInstanceByTypeWithProps(screen, RoundButton, { testID: 'machine-network-apply' })?.props.title)
      .toBe('machineDetailPage.network.closeSsh');
    // Nothing else is a way in: the evidence says so and the amber warning stands.
    const alone = await render(model({ kind: 'settled' }, true), true, { kind: 'review', plan });
    expect(findTestInstanceByTypeWithProps(alone, Item, { testID: 'machine-network-checked-other-way' })?.props.detail)
      .toBe('machineDetailPage.network.none');
    expect(findTestInstanceByTypeWithProps(alone, AttentionBanner, { testID: 'machine-network-ssh-recovery-warning' })).toBeTruthy();
  });

  it('puts the staged Review and Discard in the Machine page pinned bar when the page has one, in flow otherwise', async () => {
    const { MachineNetworkView } = await import('./MachineNetworkSection');
    const slot = createMachinePagePinnedBarSlot();
    const draft = plan.basis.change.kind === 'posture' ? plan.basis.change.posture : null;
    const view = (review: MachineNetworkReview) => React.createElement(MachineNetworkView, {
      network: model({ kind: 'settled' }, true), machineName: 'shop-prod', online: true,
      controls: { review, draft, onDraft: vi.fn(), onPrepare: vi.fn(), onPrepareChange: vi.fn(),
        onApply: vi.fn(), onCancel: vi.fn(), onOpenApproval: vi.fn() } });
    const pinned = await renderScreen(React.createElement(MachinePagePinnedBarContext.Provider, { value: slot }, view({ kind: 'idle' })));
    expect(findTestInstanceByTypeWithProps(pinned, RoundButton, { testID: 'machine-network-review' })).toBeFalsy();
    const inBar = await renderScreen(React.createElement(React.Fragment, null, slot.get()));
    expect(findTestInstanceByTypeWithProps(inBar, RoundButton, { testID: 'machine-network-review' })).toBeTruthy();
    const inFlow = await renderScreen(view({ kind: 'idle' }));
    expect(findTestInstanceByTypeWithProps(inFlow, RoundButton, { testID: 'machine-network-review' })).toBeTruthy();
  });

  it('leads an owner with nothing configured to the existing Connected services entry from both dead-end sections', async () => {
    const { MachineNetworkView } = await import('./MachineNetworkSection');
    const onConnectAccount = vi.fn();
    const empty = { ...facts, selections: [], observation: { ...observation, privateNetworks: [] } };
    const network = { ...model({ kind: 'settled' }, true), facts: { ...empty, access: projectMachineNetworkAccessFacts(empty) } };
    const controls = { review: { kind: 'idle' } as const, draft: null, onDraft: vi.fn(), onPrepare: vi.fn(), onPrepareChange: vi.fn(),
      onApply: vi.fn(), onCancel: vi.fn(), onOpenApproval: vi.fn() };
    const screen = await renderScreen(React.createElement(MachineNetworkView, {
      network, machineName: 'shop-prod', online: true, controls, onConnectAccount }));
    for (const title of ['machineDetailPage.network.ingressTitle', 'machineDetailPage.network.privateTitle']) {
      const action = findTestInstanceByTypeWithProps(screen, ItemGroup, { title })?.props.action;
      expect(action?.props.title).toBe('machineDetailPage.network.connectAccount');
      action?.props.onPress();
    }
    expect(onConnectAccount).toHaveBeenCalledTimes(2);
    // A Use member has nothing to connect here.
    const read: MachineNetworkRead = { kind: 'unrequested' };
    const use = await renderScreen(React.createElement(MachineNetworkView, {
      network: { ...network, ...presentMachineNetwork({ facts: network.facts, read, reachable: true, needsManage: true }) },
      machineName: 'shop-prod', online: true, controls, onConnectAccount }));
    expect(findTestInstanceByTypeWithProps(use, ItemGroup, { title: 'machineDetailPage.network.privateTitle' })?.props.action).toBeUndefined();
  });
});
