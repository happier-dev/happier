import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { PluginAutomationSubjectPicker } from './PluginAutomationSubjectPicker';
import { AutomationSubjectPicker } from '@happier-dev/plugin-ui/components';
import { PluginUiPresentationHostProviderInternal } from '../../../../../../packages/plugin-ui/src/presentationHost/context';
import { createPluginUiPrivatePresentationHost } from './pluginUiPrivatePresentationHost';
import { createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import { HappierUiEnvironmentProvider } from '../../../../../../packages/plugin-ui/src/environment/context';
import { projectHappierUiEnvironment } from '../../../../../../packages/plugin-ui/src/environment/projectEnvironment';

await initializeRealAppRuntimeForTests();
afterEach(standardCleanup);

it('borrows the physical Account for a null choice, reads only while open, pages and selects complete identities', async () => {
    const reads: URL[] = [];
    const onChange = vi.fn();
    const home = await serveActionHomes({ homes: [
        { key: 'addressed', serverUrl: 'https://plugin-subject-picker.test', accountId: 'author' },
        { key: 'focused', serverUrl: 'https://plugin-subject-focused.test', accountId: 'other' },
    ], route: request => {
        if (request.path !== '/v1/projects/sources') return undefined;
        expect(request.home).toBe('addressed');
        expect(request.accountId).toBe('author');
        reads.push(request.url);
        const second = request.url.searchParams.has('cursor');
        return Response.json({ ok: true, sources: [{ id: second ? 'app-b' : 'app-a', revision: 1,
            name: second ? 'Second App' : 'First App', audience: [], createdByAccountId: 'author' }],
        coverage: { complete: second, nextCursor: second ? null : 'next-app' } });
    } });
    const account = await captureLazyActionAccountContext(home.homes.addressed!.id);
    try {
        const host = createPluginUiPrivatePresentationHost(undefined, { automations: {
            accountLifetime: account.accountLifetime, target: { kind: 'app' }, isCurrent: account.accountLifetime.isCurrent,
        } });
        const screen = await renderScreen(<HappierUiEnvironmentProvider environment={projectHappierUiEnvironment(createSurfaceContextFixture())}>
            <PluginUiPresentationHostProviderInternal host={host}>
            <AutomationSubjectPicker kind={{ kind: 'app' }} value={null} onChange={onChange} testID="subject-picker" />
        </PluginUiPresentationHostProviderInternal></HappierUiEnvironmentProvider>);
        const menu = () => screen.findByType(DropdownMenu);
        expect(reads).toHaveLength(0);
        await act(async () => { menu().props.onOpenChange(true); });
        await vi.waitFor(() => expect(reads).toHaveLength(1));
        await vi.waitFor(() => expect(menu().props.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ title: 'First App' }),
        ])));
        const more = menu().props.items.find((item: { testID?: string }) => item.testID === 'subject-picker-more');
        expect(more).toBeDefined();
        await act(async () => { menu().props.onSelect(more.id); });
        await vi.waitFor(() => expect(menu().props.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ title: 'Second App' }),
        ])));
        const second = menu().props.items.find((item: { title: string }) => item.title === 'Second App');
        await act(async () => { menu().props.onSelect(second.id); });
        expect(onChange).toHaveBeenCalledWith({ kind: 'app', serverId: home.homes.addressed!.id, projectSourceId: 'app-b' });
        expect(reads.map(url => url.searchParams.get('cursor'))).toEqual([null, 'next-app']);
        await screen.unmount();
    } finally { account.dispose(); await home.dispose(); }
});

it('retires closed demand and replaced targets, and never substitutes an Account for an explicit null lifetime', async () => {
    const pending = createDeferred<Response>();
    const reads: string[] = [];
    const onChange = vi.fn();
    const home = await serveActionHomes({ homes: [
        { key: 'addressed', serverUrl: 'https://plugin-picker-target.test', accountId: 'author' },
    ], route: request => {
        if (request.path !== '/v1/projects/sources') return undefined;
        reads.push(request.home);
        return pending.promise;
    } });
    const account = await captureLazyActionAccountContext(home.homes.addressed!.id);
    const base = { kind: { kind: 'app' as const }, value: null, onChange,
        isCurrent: account.accountLifetime.isCurrent, testID: 'target-picker' };
    try {
        const screen = await renderScreen(<PluginAutomationSubjectPicker {...base} accountLifetime={null} target={{ kind: 'app' }} />);
        const menu = () => screen.findByType(DropdownMenu);
        await act(async () => { menu().props.onOpenChange(true); });
        expect(reads).toHaveLength(0);
        await screen.update(<PluginAutomationSubjectPicker {...base} accountLifetime={account.accountLifetime} target={{ kind: 'app' }} />);
        await vi.waitFor(() => expect(reads).toEqual(['addressed']));
        await act(async () => { menu().props.onOpenChange(false); });
        await act(async () => { pending.resolve(Response.json({ ok: true,
            sources: [{ id: 'stale', revision: 1, name: 'Stale', audience: [], createdByAccountId: 'author' }],
            coverage: { complete: true, nextCursor: null } })); });
        expect(menu().props.items).not.toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Stale' })]));
        await act(async () => { await home.switchAccount('addressed', 'replacement'); });
        await act(async () => { menu().props.onOpenChange(true); });
        expect(reads).toEqual(['addressed']);
        expect(onChange).not.toHaveBeenCalled();
        await screen.unmount();
    } finally { account.dispose(); await home.dispose(); }
});
