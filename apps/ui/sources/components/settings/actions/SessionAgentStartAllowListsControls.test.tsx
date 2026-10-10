import * as React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { standardCleanup } from '@/dev/testkit';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { getStorage } from '@/sync/domains/state/storage';
import { applyAcpCatalogSnapshot, resetAcpCatalogSnapshotsForTests } from '@/sync/store/settings/acpCatalogSnapshot';
import { resetAcpCatalogEngineForTests } from '@/sync/engine/settings/acpCatalogEngine';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { SessionAgentStartAllowListsControls } from './SessionAgentStartAllowListsControls';

// Native rendering is a boundary; catalog hooks, stores, selectors and menu policy stay real.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));
installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
const scope = { serverId: 'allow-list-home', accountId: 'allow-list-account' };
beforeEach(() => { getStorage().setState({ settingsScope: scope }); });
afterEach(async () => {
    await standardCleanup();
    resetAcpCatalogEngineForTests();
    resetAcpCatalogSnapshotsForTests();
});

describe('session start Agent allow-list catalog readiness', () => {
    it('does not expand All into an incomplete finite Agent policy when a bundled choice is toggled while ACP is unavailable', async () => {
        applyAcpCatalogSnapshot(scope, { status: 'unavailable', reason: 'account-mode-mismatch' }, true);
        const onChange = vi.fn();
        function PolicyOwner({ initial }: { initial: string[] | null }) {
            const [selected, setSelected] = React.useState(initial);
            return <SessionAgentStartAllowListsControls rawAllowLists={{ allowedAgentTargetKeys: selected }}
                onChange={next => { onChange(next); setSelected(next.allowedAgentTargetKeys); }} />;
        }
        const screen = await renderSettingsView(<PolicyOwner initial={null} />);
        await screen.pressByTestIdAsync('settings-actions:session-start-allow-lists:agents');
        const menu = () => screen.findAll(node => node.type === DropdownMenu)[0];
        expect(menu()).toBeDefined();
        expect(menu().props.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'all', checked: true }),
            expect.objectContaining({ id: 'none' }),
        ]));
        expect(menu().props.items.find((item: { id: string }) => item.id === 'all').disabled).not.toBe(true);
        expect(menu().props.items.find((item: { id: string }) => item.id === 'none').disabled).not.toBe(true);
        const bundledChoice = menu().props.items.find((item: { id: string }) => item.id.startsWith('choice:agent:'));
        expect(bundledChoice).toBeDefined();
        await act(async () => { menu().props.onSelect(bundledChoice.id); });
        // null means every Agent, including configured IDs that have not been read.
        // A partial list of rendered choices cannot author that finite replacement.
        expect(onChange).not.toHaveBeenCalled();
        await act(async () => { menu().props.onSelect('none'); });
        expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ allowedAgentTargetKeys: [] }));
        await act(async () => { menu().props.onSelect('all'); });
        expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ allowedAgentTargetKeys: null }));
        await act(async () => { screen.tree.unmount(); });

        const retained = 'backend:retained:configured:retained';
        const finite = await renderSettingsView(<PolicyOwner initial={[retained]} />);
        await finite.pressByTestIdAsync('settings-actions:session-start-allow-lists:agents');
        const finiteMenu = () => finite.findAll(node => node.type === DropdownMenu)[0];
        expect(finiteMenu().props.items).toContainEqual(expect.objectContaining({ id: `choice:${retained}`, checked: true }));
        expect(finiteMenu().props.items.find((item: { id: string }) => item.id === bundledChoice.id).disabled).not.toBe(true);
        await act(async () => { finiteMenu().props.onSelect(bundledChoice.id); });
        expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
            allowedAgentTargetKeys: [retained, bundledChoice.id.slice('choice:'.length)],
        }));
        await act(async () => { finiteMenu().props.onSelect(bundledChoice.id); });
        expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ allowedAgentTargetKeys: [retained] }));
        await act(async () => { applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 2, record: { v: 1, definitions: [] } }, true); });
        await act(async () => { finiteMenu().props.onSelect('all'); });
        await act(async () => { finiteMenu().props.onSelect(bundledChoice.id); });
        const knownFinite = onChange.mock.lastCall?.[0].allowedAgentTargetKeys;
        expect(knownFinite).toEqual(expect.any(Array));
        expect(knownFinite).not.toContain(bundledChoice.id.slice('choice:'.length));
    });
});
