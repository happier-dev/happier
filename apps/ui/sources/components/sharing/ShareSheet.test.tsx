import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { ShareSheet } from './ShareSheet';
import { createDocumentShareAdapter } from './documents/documentShareAdapter';
import { buildShareSheetSelectionStep } from './buildShareSheetSelectionStep';
import type { ShareSheetActions, ShareSheetModel } from './shareSheetTypes';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
// The virtualized renderer is a third-party boundary; all sharing/list logic stays real.
vi.mock('@legendapp/list/react-native', async () => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit');
    return { LegendList: createCapturingLegendListMock({ renderItems: true }).module.LegendList };
});

const noop = () => {};
const actions: ShareSheetActions = {
    setQuery: noop, retryDirectory: noop, loadMore: noop, addPrincipal: noop, retryMutation: noop,
    setAccessLevel: noop, requestRemove: noop, confirmRemove: noop, cancelRemove: noop, explain: noop,
};
const model: ShareSheetModel = {
    revision: 0, editable: true, stale: false, owner: null, grants: [],
    directory: { query: '', sections: [] },
};
const adapter = createDocumentShareAdapter({ artifactId: 'wf-1', kind: 'workflow-definition.v1',
    grants: [], loading: false, readOnly: false, retryContent: noop });

describe('ShareSheet full presentation', () => {
    it('announces adapter readiness and responsibility as part of the principal row', () => {
        const roster: ShareSheetModel = { ...model, grants: [{
            grant: { kind: 'account', accountId: 'bob' },
            principal: { ref: { kind: 'account', accountId: 'bob' }, key: 'account:bob', displayName: 'Bob', accessibilityLabel: 'Bob' },
            level: { kind: 'editable', value: 'view', options: ['view'] },
            removal: { kind: 'allowed' }, operation: { kind: 'idle' },
        }] };
        const step = buildShareSheetSelectionStep({ model: roster, actions,
            adapter: { ...adapter, principalTags: () => ['Encrypted access pending', 'Responsible'] },
            presentation: 'full', onExpand: noop, idPrefix: '' });
        const current = step.sections.find(section => section.id === 'current');
        expect(current?.kind === 'static' ? current.options[0]?.accessibilityLabel : undefined)
            .toBe('Bob, Encrypted access pending, Responsible');
    });
    it('opens a public-link editor through the same roster row for every adapter', async () => {
        const open = vi.fn();
        const screen = await renderScreen(<ShareSheet model={model} actions={actions}
            adapter={{ ...adapter, publicLink: { stateLabel: 'Off', onOpen: open } }} presentation="full" testID="document-share-editor" />);
        await screen.pressByTestIdAsync('document-share-public-link');
        expect(open).toHaveBeenCalledOnce();
    });
    it('uses the adapter supported levels for both the grant controls and the full help legend', async () => {
        const machineAdapter = { ...adapter, levels: {
            view: { label: 'Use', help: 'Run work' },
            admin: { label: 'Manage', help: 'Share access' },
        } };
        const roster: ShareSheetModel = { ...model, grants: [{
            grant: { kind: 'account', accountId: 'bob' },
            principal: { ref: { kind: 'account', accountId: 'bob' }, key: 'account:bob', displayName: 'Bob', accessibilityLabel: 'Bob' },
            level: { kind: 'editable', value: 'view', options: ['view', 'edit', 'admin'] },
            removal: { kind: 'allowed' }, operation: { kind: 'idle' },
        }] };
        const screen = await renderScreen(<ShareSheet model={roster} actions={actions}
            adapter={machineAdapter} presentation="full" testID="machine-share-editor" />);
        expect(screen.findByTestId('machine-share-editor:document-share-help')).not.toBeNull();
        await screen.pressByTestIdAsync('machine-share-editor:document-share-grant-account:bob');
        expect(screen.findByTestId('machine-share-editor:document-share-level:account:bob:view')).not.toBeNull();
        expect(screen.findByTestId('machine-share-editor:document-share-level:account:bob:admin')).not.toBeNull();
        expect(screen.findByTestId('machine-share-editor:document-share-level:account:bob:edit')).toBeNull();
    });
    it('keeps the level explanation outside the selectable roster and offers a direct completion action', async () => {
        const close = vi.fn();
        const sendCopy = vi.fn();
        const screen = await renderScreen(<ShareSheet model={model} actions={actions}
            adapter={{ ...adapter, sendCopy }} presentation="full" onRequestClose={close} testID="document-share-editor" />);

        expect(screen.findByTestId('document-share-help')).not.toBeNull();
        expect(screen.findAll(node => typeof node.props.testID === 'string'
            && node.props.testID.includes(':option:level-help:'))).toEqual([]);
        expect(screen.findByTestId('document-share-editor:list:document-share:option:send-copy')).toBeNull();
        await screen.pressByTestIdAsync('document-share-send-copy');
        expect(sendCopy).toHaveBeenCalledOnce();
        await screen.pressByTestIdAsync('document-share-done');
        expect(close).toHaveBeenCalledOnce();
    });

    it('hides empty Team and Team-group browse actions and keeps a directory with another page reachable', async () => {
        const directories = ['team', 'group'] as const;
        const loadingModel: ShareSheetModel = { ...model, directory: { query: '', sections: directories.map(kind => ({
            kind, title: kind === 'team' ? 'Teams' : 'Groups', candidates: [], status: 'loading',
            cursor: null, hasMore: false, loadingMore: false,
        })) } };
        const screen = await renderScreen(<ShareSheet model={loadingModel} actions={actions}
            adapter={adapter} presentation="full" testID="document-share-editor" />);
        await flushHookEffects();
        for (const kind of directories) expect(screen.findByTestId(`document-share-browse:${kind}`)).toBeNull();
        await screen.update(<ShareSheet model={{ ...loadingModel, revision: 1, directory: { query: '',
            sections: loadingModel.directory.sections.map(source => ({ ...source, status: 'idle' })) } }}
            actions={actions} adapter={adapter} presentation="full" testID="document-share-editor" />);
        await flushHookEffects();
        for (const kind of directories) expect(screen.findByTestId(`document-share-browse:${kind}`)).toBeNull();
        await screen.update(<ShareSheet model={{ ...loadingModel, revision: 2, directory: { query: '',
            sections: loadingModel.directory.sections.map(source => ({ ...source, status: 'idle', hasMore: source.kind === 'team' })) } }}
            actions={actions} adapter={adapter} presentation="full" testID="document-share-editor" />);
        await flushHookEffects();
        expect(screen.findByTestId('document-share-browse:team')).not.toBeNull();
        expect(screen.findByTestId('document-share-browse:group')).toBeNull();
    });

    it('retains an adapter before-grant disclosure when browsing a pushed directory step', async () => {
        const disclosureAdapter = { ...adapter, showLeadingOnDirectorySteps: true,
            sections: () => ({ leading: [{ kind: 'static' as const, id: 'trust', options: [{
                id: 'trust', testID: 'machine-trust', label: 'Trusted OS access', disabled: true,
            }] }] }),
        };
        const withTeam: ShareSheetModel = { ...model, directory: { query: '', sections: [{
            kind: 'team', title: 'Teams', candidates: [], status: 'idle', cursor: 'next', hasMore: true, loadingMore: false,
        }] } };
        const screen = await renderScreen(<ShareSheet model={withTeam} actions={actions}
            adapter={disclosureAdapter} presentation="full" testID="document-share-editor" />);
        expect(screen.findByTestId('machine-trust')).not.toBeNull();
        await screen.pressByTestIdAsync('document-share-browse:team');
        expect(screen.findByTestId('machine-trust')).not.toBeNull();
        await screen.pressByTestIdAsync('document-share-editor:list:header:leading:back-chip');
        expect(screen.findByTestId('document-share-browse:team')).not.toBeNull();
    });
});
