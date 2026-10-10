import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';

const modalBoundary = vi.hoisted(() => ({ prompt: vi.fn(), confirm: vi.fn(), alert: vi.fn() }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: modalBoundary }).module);
// Only window/portal presentation is replaced; Gallery rows, commands, policy and Artifact CAS stay real.
vi.mock('@/components/ui/popover', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
const { flushHookEffects } = await import('@/dev/testkit/hooks/flushHookEffects');
const { useAccountWidgetAddSections } = await import('../add/accountWidgetAddSections');
const { WidgetAddPanel } = await import('../add/WidgetAddSurface');
const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { storage } = await import('@/sync/domains/state/storage');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');

const ACCOUNT_ID = 'account-a';
const DRAFT = { name: 'Release checks', inputs: { fields: [] }, inputSchema: { type: 'object' },
    group: { width: 'full', frameStyle: 'card', dividers: 'hairline', children: [{ kind: 'widget',
        instance: { v: 1, definition: { kind: 'builtin', id: 'summary' }, bindings: {} } }] } } as const;
const NO_INSTANCES = Object.freeze([]);
const LABELS = { count: String, submit: 'Add' };
const addInstance = async () => ({ ok: true as const });
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;

async function renderGallery() {
    const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://fragments-home.example', accountId: ACCOUNT_ID });
    const account = { serverId, accountId: ACCOUNT_ID };
    storage.setState({ profileScope: account, settingsScope: account });
    harness.answer(serverId, '/v1/auth/ping', { body: { success: true } });
    harness.answer(serverId, '/v1/account/encryption/currentness', {
        body: { mode: 'plain', version: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 },
    });
    // Match app entry: publish real Sync before restoring the active Account lifetime.
    connection = await restoreServerAccountForTest({ serverUrl: 'https://fragments-home.example', accountId: ACCOUNT_ID, request: harness.request });
    installHomeGovernanceBoundaries(harness);
    storage.setState({ profileScope: account, settingsScope: account });
    expect(captureActiveServerAccountScopeLifetime()?.scope).toEqual(account);
    const executor = createDefaultActionExecutor();
    const context = { serverId, surface: 'ui', authority: 'present_user' } as const;
    expect(await executor.execute('widgets.fragment.create', { account, artifactId: 'saved', fragment: DRAFT }, context)).toMatchObject({ ok: true });
    const scope = { ...account, owner: { kind: 'home' } } as const;
    function Gallery() {
        const sections = useAccountWidgetAddSections({ scope, instances: NO_INSTANCES, labels: LABELS, addInstance, testID: 'gallery' });
        return <WidgetAddPanel title="Add" searchPlaceholder="Search" addLabel="Add" composition="split"
            sections={sections} onRequestClose={() => {}} testID="gallery" />;
    }
    const screen = await renderScreen(<AppShellPluginUiProjectionValueProvider value={{
        pluginUiProjection: null, pluginBrowserProjection: null, phase: 'current', interactionEnabled: false, machineId: null,
        serverId, platform: 'web', reloadConnectedAccountProjection: () => {}, accountLifetime: captureActiveServerAccountScopeLifetime(),
        clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {},
    }}><Gallery /></AppShellPluginUiProjectionValueProvider>);
    await vi.waitFor(() => expect(screen.findByTestId('gallery.entry.group-saved')).not.toBeNull());
    async function choose(action: string) {
        await screen.pressByTestIdAsync('gallery.entry.group-saved.actions');
        await screen.pressByTestIdAsync(action);
        await flushHookEffects({ cycles: 2 });
    }
    return { screen, choose, account, executor, context, serverId };
}

describe('saved-group Gallery management', () => {
    beforeEach(async () => { await harness.reset(); modalBoundary.prompt.mockReset(); modalBoundary.confirm.mockReset(); modalBoundary.alert.mockReset(); });
    afterEach(async () => {
        standardCleanup();
        if (connection) { await connection.dispose(); connection = null; installHomeGovernanceBoundaries(harness); }
    });

    it('renames the saved group through current Artifact revisions, duplicates independently, and refreshes after delete', async () => {
        const { screen, choose, account, executor, context, serverId } = await renderGallery();
        expect(screen.findByTestId('gallery.detail.submit')?.props.disabled).toBe(true);
        modalBoundary.prompt.mockResolvedValue('  Release room  ');
        // Another writer changes an unrelated field at the real CAS boundary before Rename commits.
        harness.artifacts(serverId).beforeNextUpdate(async () => {
            expect(await executor.execute('widgets.fragment.update', { account, artifactId: 'saved', patch: { description: 'Kept by another client' } }, context)).toMatchObject({ ok: true });
        });
        await choose('rename');
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Release room'));
        const renamed = await executor.execute('widgets.fragment.get', { account, artifactId: 'saved' }, context);
        expect(renamed).toMatchObject({ ok: true, result: { fragment: { name: 'Release room', description: 'Kept by another client', group: DRAFT.group } } });
        expect(screen.findByTestId('gallery.detail.submit')?.props.disabled).toBe(true);
        await choose('duplicate');
        await vi.waitFor(() => expect(harness.artifacts(serverId).list()).toHaveLength(2));
        const copyId = harness.artifacts(serverId).list().find(row => row.id !== 'saved')!.id;
        await vi.waitFor(() => expect(screen.findByTestId(`gallery.entry.group-${copyId}`)).not.toBeNull());
        expect(await executor.execute('widgets.fragment.get', { account, artifactId: copyId }, context)).toMatchObject({ ok: true, result: { fragment: { id: copyId, group: DRAFT.group } } });
        modalBoundary.confirm.mockResolvedValue(true);
        await choose('delete');
        await vi.waitFor(() => expect(screen.findByTestId('gallery.entry.group-saved')).toBeNull());
        expect(harness.artifacts(serverId).read('saved')).toBeNull();
        expect(harness.artifacts(serverId).read(copyId)).not.toBeNull();
    });

    it('cancels naming/deletion without a write and keeps a refused mutation visible and retryable', async () => {
        const { screen, choose, serverId } = await renderGallery();
        const original = harness.artifacts(serverId).readPlainBody('saved');
        modalBoundary.prompt.mockResolvedValue(null);
        await choose('rename');
        modalBoundary.confirm.mockResolvedValue(false);
        await choose('delete');
        expect(harness.artifacts(serverId).readPlainBody('saved')).toBe(original);
        modalBoundary.prompt.mockResolvedValue('Release room');
        harness.answer(serverId, 'POST /v1/artifacts/saved', { status: 503, body: { error: 'unavailable' } });
        await choose('rename');
        await vi.waitFor(() => expect(modalBoundary.alert).toHaveBeenCalled());
        expect(harness.artifacts(serverId).readPlainBody('saved')).toBe(original);
        expect(screen.findByTestId('gallery.entry.group-saved.actions')).not.toBeNull();
    });

    it('does not finish a pending rename after its Account lifetime retires', async () => {
        const { choose, serverId } = await renderGallery();
        const original = harness.artifacts(serverId).readPlainBody('saved');
        modalBoundary.prompt.mockImplementation(async () => {
            const nextAccount = { serverId, accountId: 'account-b' };
            storage.setState({ profileScope: nextAccount, settingsScope: nextAccount });
            return 'Wrong Account';
        });
        await choose('rename');
        expect(harness.artifacts(serverId).readPlainBody('saved')).toBe(original);
    });
});
