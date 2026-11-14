import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { installBrowserClipboardBoundary } from '@/dev/testkit/harness/browserClipboardBoundary';

// Home/Account environment is the boundary; the retained outcome store and detail surface stay real.
installApprovalCommonModuleMocks();
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
const { ActionOperationDetailModal } = await import('./ActionOperationDetailModal');

beforeEach(async () => { standardCleanup(); await homes.reset(); actionOperationStore.reset(); });
afterEach(() => { standardCleanup(); actionOperationStore.reset(); });

it.each(['succeeded', 'failed', 'publication_failure'] as const)('shows and copies exact saved firewall recovery from a fresh %s Action detail without task or SSH access', async outcome => {
  const state = outcome === 'succeeded' ? 'succeeded' : 'failed';
  const copied: string[] = [];
  installBrowserClipboardBoundary(async text => { copied.push(text); });
  const home = await homes.addHome({ name: 'Studio Home', serverUrl: 'https://network-outcome.test',
    accountId: 'owner', serverIdentityId: 'srv_network_outcome' });
  const recovery = { rules: { kind: 'file', content: 'table inet happier {\n  # exact prior rules\n}\n' },
    unit: { kind: 'file', content: '[Unit]\nDescription=Prior unit\n' }, table: null,
    boot: { present: true, enabled: false, running: true } };
  // This is the complete V2 outcome read, independent of the completed interactive task's memory.
  const snapshot = ActionOperationSnapshotV1Schema.parse(JSON.parse(JSON.stringify({
    version: 1, operationId: 'network-operation', revision: 3, actionId: 'machines.reachability.configure',
    state, scope: { accountId: 'owner', machineId: 'studio-machine' },
    title: 'Configure Network', createdAt: 1000, startedAt: 1100, settledAt: 2000, cancellation: 'unsupported',
    domainRef: { kind: 'machineSetup', serverId: home, machineId: 'studio-machine' },
    ...(state === 'failed' ? { error: { errorCode: outcome === 'publication_failure' ? 'machine_reachability_publication_unavailable' : 'native_effect_failed', error: 'Firewall outcome is unknown',
      details: { status: 'recoveryRequired', ...(outcome === 'publication_failure' ? {} : { failure: { kind: 'native_effect_failed' } }), recovery,
        remedy: 'Use the independent administrator console.' } } } : {
    result: { status: 'applied', machineId: 'studio-machine', metadataVersion: 2,
      posture: { revision: 1, management: { providers: [], publicSsh: { kind: 'closed' } }, defaultServiceIngress: { kind: 'none' } },
      selections: [], observation: { revision: 1, management: { daemon: 'ready', providers: [], publicSsh: 'closed' },
        privateNetworks: [], ingress: [] }, recovery } }),
  })));
  actionOperationStore.mergeSnapshots({ serverId: home, snapshots: [snapshot], snapshotComplete: true });
  const screen = await renderScreen(<ActionOperationDetailModal serverId={home} operationId="network-operation"
    onClose={vi.fn()} setChrome={vi.fn()} />);
  try {
    await flushHookEffects();
    const text = screen.getTextContent();
    expect(text).toContain('exact prior rules');
    expect(text).toContain('Prior unit');
    await act(async () => { await screen.findByProps({ accessibilityLabel: 'common.copy' }).props.onPress(); });
    expect(copied).toHaveLength(1);
    expect(JSON.parse(copied[0]!)).toEqual(recovery);
    expect(homes.requests.some(request => request.path.includes('system-tasks'))).toBe(false);
  } finally { await screen.unmount(); }
});
