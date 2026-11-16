import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installAccountCommonModuleMocks } from '@/components/account/accountTestHelpers';
import { resolveHomeConnectionSummary } from '@/components/navigation/connectionStatus/resolveHomeConnectionSummary';
import { SelectableRow } from '@/components/ui/lists/SelectableRow';
import { listServerSelectionTargets } from '@/sync/domains/server/selection/serverSelectionResolver';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';
import { AccountPopoverContent } from './AccountPopoverContent';

installAccountCommonModuleMocks();

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({});
});

describe('AccountPopoverContent pairing entry', () => {
    beforeEach(() => {
        standardCleanup();
        vi.clearAllMocks();
        // Account-service discovery is an HTTP boundary; the real entry policy still runs.
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }));
    });

    afterEach(() => vi.restoreAllMocks());

    it('visibly distinguishes an unnamed peer while keeping each Home health subtitle', async () => {
        const servers: ServerProfile[] = ['home-a', 'home-b'].map((id) => ({
            id, name: `${id}.example.test`, serverUrl: `https://${id}.example.test`,
            createdAt: 0, updatedAt: 0, lastUsedAt: 0,
        }));
        const screen = await renderScreen(<AccountPopoverContent
            step="root" onStepChange={() => {}}
            servers={servers} targets={listServerSelectionTargets({ serverProfiles: servers, groupProfiles: [] })}
            activeGroupId={null} activeServerId="home-a" displayServerId="home-a"
            displayServerProfile={servers[0]!} displayHomeLabel="settingsAccount.thisHomeTitle" pendingServerId={null}
            homeSummary={resolveHomeConnectionSummary({ healthKind: 'healthy' })}
            machineSummary={{ kind: 'unknown' }} showsMachineGuidance={false}
            runtimeOrigin={null} homeCarrier={null}
            switchServer={async () => 'switched'} onRetry={async () => {}} retryBusy={false}
            onRestore={() => {}} onAddHome={() => {}} onManageHomes={() => {}} onOpenSettings={() => {}}
            onClose={() => {}} renderDetails={() => null}
        />);
        const rows = screen.findAllByType(SelectableRow)
            .filter((row) => ['connection-popover-home-server-home-a', 'connection-popover-home-server-home-b'].includes(row.props.testID));
        expect(rows.map((row) => row.props.title)).toEqual([
            'settingsAccount.thisHomeTitle', 'https://home-b.example.test',
        ]);
        expect(rows.every((row) => Boolean(row.props.subtitle))).toBe(true);
    });

    it('closes the popover and opens the shared pairing modal for the displayed Home', async () => {
        const { Modal } = await import('@/modal');
        const onClose = vi.fn();
        const screen = await renderScreen(<AccountPopoverContent
            step="root" onStepChange={() => {}}
            servers={[]} targets={[]} activeGroupId={null}
            activeServerId="home-a" displayServerId="home-b" displayServerProfile={null}
            displayHomeLabel="Home B" pendingServerId={null}
            homeSummary={resolveHomeConnectionSummary({ healthKind: 'healthy' })}
            machineSummary={{ kind: 'unknown' }} showsMachineGuidance={false}
            runtimeOrigin={null} homeCarrier={null}
            switchServer={async () => 'switched'} onRetry={async () => {}} retryBusy={false}
            onRestore={() => {}} onAddHome={() => {}} onManageHomes={() => {}} onOpenSettings={() => {}}
            onClose={onClose} renderDetails={() => null}
        />);

        const row = screen.findByTestId('connection-popover-add-device');
        expect(row).not.toBeNull();
        await row?.props.onPress();

        expect(onClose).toHaveBeenCalled();
        expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({
            props: { purpose: 'phone', targetProfileId: 'home-b' },
        }));
        expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(Modal.show).mock.invocationCallOrder[0]);
    });
});
