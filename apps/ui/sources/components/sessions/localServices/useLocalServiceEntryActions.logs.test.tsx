import { afterEach, expect, it } from 'vitest';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { LocalServiceLaunchTargetV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { buildLocalServiceRows } from '@/sync/domains/local/services/serviceRow';
import { resolveLocalServiceEntryActions } from './localServiceEntryActions';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { useLocalServiceEntryActions } = await import('./useLocalServiceEntryActions');
afterEach(async () => { await home.reset(); });

it('offers retained service logs without a lifecycle effect and drops the selection when its workspace changes', async () => {
    const serverId = await home.addHome({ name: 'Service logs', serverUrl: 'https://service-logs.test', accountId: 'account', currentAccount: true });
    const hook = await renderHook((workspaceRoot: string) => useLocalServiceEntryActions({
        machineId: 'machine', serverId, workspaceRoot, scope: 'workspace', testID: 'service-logs',
    }), { initialProps: '/repo' });
    try {
        await waitForHomeGovernance(() => expect(hook.getCurrent().viewerAccountId).toBe('account'));
        const target = LocalServiceLaunchTargetV1Schema.parse({ id: 'declaration', source: 'managed_service', machineId: 'machine',
            title: 'web', confidence: 'high', state: 'unavailable', serviceState: 'stopped', unavailableReason: 'launch_unavailable', actions: [],
            sourceClass: { kind: 'managed_service', managedServiceId: 'occurrence' } });
        const row = buildLocalServiceRows({ inventoryRows: [], launchTargets: [target], sessionId: null, scope: 'workspace' })[0];
        const occurrence = resolveLocalServiceEntryActions(row, hook.getCurrent().handlers).showLogs;
        expect(occurrence).toEqual({ machineId: 'machine', serviceId: 'declaration', expectedGeneration: 'occurrence', name: 'web' });
        const requestsBeforeShow = home.requests.length;
        await act(async () => { await hook.getCurrent().handlers.onShowServiceLogs?.(occurrence!); });
        expect(hook.getCurrent().logOccurrence).toEqual(occurrence);
        expect(home.requests.slice(requestsBeforeShow)).toEqual([]);
        await act(async () => { hook.getCurrent().dismissServiceLogs(); });
        expect(hook.getCurrent().logOccurrence).toBeNull();
        await act(async () => { await hook.getCurrent().handlers.onShowServiceLogs?.(occurrence!); });
        await hook.rerender('/other-repo');
        expect(hook.getCurrent().logOccurrence).toBeNull();
        await hook.rerender('/repo');
        expect(hook.getCurrent().logOccurrence).toBeNull();
    } finally { await hook.unmount(); }
});
