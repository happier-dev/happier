import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { ShareSheet } from './ShareSheet';
import { t } from '@/text';
import { createDocumentShareAdapter } from './documents/documentShareAdapter';
import { buildShareSheetSelectionStep } from './buildShareSheetSelectionStep';
import type { ShareSheetActions, ShareSheetModel } from './shareSheetTypes';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
// The virtualized renderer is a third-party boundary; all sharing/list logic stays real.
vi.mock('@legendapp/list/react-native', async () => {
    const { createLegendListModuleMock } = await import('@/dev/testkit/mocks/legendList');
    return createLegendListModuleMock({ renderItems: true });
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

afterEach(() => vi.useRealTimers());

async function startAdding(screen: Awaited<ReturnType<typeof renderScreen>>, inputTestID = 'document-share-search') {
    const input = screen.find(node => node.props?.testID === inputTestID && typeof node.props.onFocus === 'function');
    await act(async () => { input.props.onFocus(); });
}

describe('ShareSheet full presentation', () => {
    it('offers adding suggestions separately from granted access, without implying a selected grant', async () => {
        vi.useFakeTimers();
        const add = vi.fn();
        const candidates: ShareSheetModel = { ...model, directory: { query: '', sections: [{
            kind: 'account', title: 'People', status: 'idle', cursor: null, hasMore: false, loadingMore: false,
            candidates: [{ principal: { ref: { kind: 'account', accountId: 'maya' }, key: 'account:maya',
                displayName: 'Maya', accessibilityLabel: 'Maya' }, addition: { kind: 'allowed' }, operation: { kind: 'idle' } }],
        }] } };
        const screen = await renderScreen(<ShareSheet model={candidates} actions={{ ...actions, addPrincipal: add }}
            adapter={adapter} presentation="full" testID="document-share-editor" />);
        await startAdding(screen);
        await flushHookEffects({ runOnlyPendingTimers: true });
        await screen.pressByTestIdAsync('document-share-add:account:maya');
        expect(add).toHaveBeenCalledWith({ kind: 'account', accountId: 'maya' });
        expect(screen.findByTestId('document-share-grant-account:maya')).toBeNull();
        expect(screen.findAll(node => typeof node.props.testID === 'string'
            && node.props.testID.includes('option-selected-mark'))).toEqual([]);
    });
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

    it('keeps a suggestion heading out until its first load resolves, so opening the sheet moves nothing twice', async () => {
        vi.useFakeTimers();
        const heading = t('shareSheet.suggestions', { kind: 'People' });
        const loading: ShareSheetModel = { ...model, directory: { query: '', sections: [{
            kind: 'account', title: 'People', status: 'loading', cursor: null, hasMore: false, loadingMore: false, candidates: [],
        }] } };
        const screen = await renderScreen(<ShareSheet model={loading} actions={actions}
            adapter={adapter} presentation="inline" testID="document-share-editor" />);
        await startAdding(screen);
        await flushHookEffects({ advanceTimersMs: 1 });
        expect(screen.getTextContent()).not.toContain(heading);
        await screen.update(<ShareSheet model={{ ...loading, revision: 1, directory: { query: '', sections: [{
            ...loading.directory.sections[0]!, status: 'idle',
            candidates: [{ principal: { ref: { kind: 'account', accountId: 'maya' }, key: 'account:maya',
                displayName: 'Maya', accessibilityLabel: 'Maya' }, addition: { kind: 'allowed' }, operation: { kind: 'idle' } }],
        }] } }} actions={actions} adapter={adapter} presentation="inline" testID="document-share-editor" />);
        await flushHookEffects({ runOnlyPendingTimers: true });
        expect(screen.getTextContent()).toContain(heading);
    });

    it('lists directory suggestions only once someone starts adding, keeping every directory one Browse away before that', async () => {
        vi.useFakeTimers();
        const person = (id: string) => ({ principal: { ref: { kind: 'account' as const, accountId: id }, key: `account:${id}`,
            displayName: id, accessibilityLabel: id }, addition: { kind: 'allowed' as const }, operation: { kind: 'idle' as const } });
        const team = { principal: { ref: { kind: 'team' as const, teamId: 'design' }, key: 'team:design',
            displayName: 'Design', accessibilityLabel: 'Design' }, addition: { kind: 'allowed' as const }, operation: { kind: 'idle' as const } };
        const directory = (query: string): ShareSheetModel => ({ ...model, directory: { query, sections: [
            { kind: 'account', title: 'People', status: 'idle', cursor: null, hasMore: false, loadingMore: false, candidates: [person('grace'), person('nora')] },
            { kind: 'team', title: 'Teams', status: 'idle', cursor: null, hasMore: false, loadingMore: false, candidates: [team] },
        ] } });
        const screen = await renderScreen(<ShareSheet model={directory('')} actions={actions}
            adapter={adapter} presentation="inline" testID="document-share-editor" />);
        await flushHookEffects({ runOnlyPendingTimers: true });
        // At rest the sheet is the roster: no suggestion rows, but each directory stays browsable.
        expect(screen.findByTestId('document-share-candidate-account:grace')).toBeNull();
        expect(screen.findByTestId('document-share-candidate-team:design')).toBeNull();
        expect(screen.getTextContent()).not.toContain(t('shareSheet.suggestions', { kind: 'People' }));
        expect(screen.findByTestId('document-share-browse:account')).not.toBeNull();
        expect(screen.findByTestId('document-share-browse:team')).not.toBeNull();

        await startAdding(screen);
        await flushHookEffects({ runOnlyPendingTimers: true });
        expect(screen.findByTestId('document-share-candidate-account:grace')).not.toBeNull();
        expect(screen.findByTestId('document-share-candidate-team:design')).not.toBeNull();
        // Every person is already listed, so People needs no Browse entry while suggestions show.
        expect(screen.findByTestId('document-share-browse:account')).toBeNull();
        expect(screen.findByTestId('document-share-browse:team')).not.toBeNull();
    });

    it('leads with the matches while a query is typed, then who already has access', () => {
        const typed = (query: string): ShareSheetModel => ({ ...model, directory: { query, sections: [{
            kind: 'account', title: 'People', status: 'idle', cursor: null, hasMore: false, loadingMore: false, candidates: [] }] } });
        const sectionIds = (value: ShareSheetModel) => buildShareSheetSelectionStep({ model: value, actions,
            adapter: { ...adapter, sections: () => ({ afterAccess: [{ kind: 'static', id: 'answerers', options: [] }],
                trailing: [{ kind: 'static', id: 'agent-results', options: [] }] }) },
            presentation: 'inline', onExpand: noop, idPrefix: '', revealSuggestions: true }).sections.map(section => section.id);
        const atRest = sectionIds(typed(''));
        expect(atRest.indexOf('current')).toBeLessThan(atRest.indexOf('directory:account'));
        const searching = sectionIds(typed('ma'));
        expect(searching.indexOf('directory:account')).toBeLessThan(searching.indexOf('current'));
        expect(searching.indexOf('agent-results')).toBeLessThan(searching.indexOf('current'));
        expect(searching.indexOf('current')).toBeLessThan(searching.indexOf('answerers'));
    });
    it('says who the people directory lists and where to connect with someone when it has no one to offer', () => {
        const people = (partial: Partial<ShareSheetModel['directory']['sections'][number]>, query = ''): ShareSheetModel => ({ ...model,
            directory: { query, sections: [{ kind: 'account', title: 'People', status: 'idle', cursor: null, hasMore: false,
                loadingMore: false, candidates: [], ...partial }] } });
        const sectionIds = (value: ShareSheetModel) => buildShareSheetSelectionStep({ model: value, actions, adapter, presentation: 'full',
            onExpand: noop, idPrefix: '', directoryKind: 'account' }).sections.map(section => section.id);
        expect(sectionIds(people({}))).toContain('directory-empty');
        // Still loading, another page to come, a typed search and a directory with someone in it are not this state.
        expect(sectionIds(people({ status: 'loading' }))).not.toContain('directory-empty');
        expect(sectionIds(people({ hasMore: true }))).not.toContain('directory-empty');
        expect(sectionIds(people({}, 'ma'))).not.toContain('directory-empty');
        expect(sectionIds(people({ candidates: [{ principal: { ref: { kind: 'account', accountId: 'maya' }, key: 'account:maya',
            displayName: 'Maya', accessibilityLabel: 'Maya' }, addition: { kind: 'allowed' }, operation: { kind: 'idle' } }] })))
            .not.toContain('directory-empty');
    });
    it('names why a candidate cannot be added instead of offering Add, and explains it on press', async () => {
        vi.useFakeTimers();
        const explain = vi.fn();
        const add = vi.fn();
        const reason = { code: 'team_external_sharing_disabled', message: 'Grace is outside Product Reliability, which doesn’t share outside the Team.' };
        const refused: ShareSheetModel = { ...model, directory: { query: 'gr', sections: [{
            kind: 'account', title: 'People', status: 'idle', cursor: null, hasMore: false, loadingMore: false,
            candidates: [{ principal: { ref: { kind: 'account', accountId: 'grace' }, key: 'account:grace',
                displayName: 'Grace', accessibilityLabel: 'Grace' }, addition: { kind: 'blocked', reason }, operation: { kind: 'idle' } }],
        }] } };
        const screen = await renderScreen(<ShareSheet model={refused} actions={{ ...actions, explain, addPrincipal: add }}
            adapter={adapter} presentation="inline" testID="document-share-editor" />);
        await flushHookEffects({ runOnlyPendingTimers: true });
        expect(screen.findByTestId('document-share-candidate-account:grace')).not.toBeNull();
        expect(screen.findByTestId('document-share-add:account:grace')).toBeNull();
        expect(screen.getTextContent()).toContain(t('shareSheet.cantAdd'));
        await screen.pressByTestIdAsync('document-share-candidate-account:grace');
        expect(explain).toHaveBeenCalledWith(reason);
        expect(add).not.toHaveBeenCalled();
    });

    it('lists matching suggestions for a typed query without a focus event (a restored search)', async () => {
        vi.useFakeTimers();
        const typed: ShareSheetModel = { ...model, directory: { query: 'gr', sections: [{
            kind: 'account', title: 'People', status: 'idle', cursor: null, hasMore: false, loadingMore: false,
            candidates: [{ principal: { ref: { kind: 'account', accountId: 'grace' }, key: 'account:grace',
                displayName: 'Grace', accessibilityLabel: 'Grace' }, addition: { kind: 'allowed' }, operation: { kind: 'idle' } }],
        }] } };
        const screen = await renderScreen(<ShareSheet model={typed} actions={actions}
            adapter={adapter} presentation="inline" testID="document-share-editor" />);
        await flushHookEffects({ runOnlyPendingTimers: true });
        expect(screen.findByTestId('document-share-candidate-account:grace')).not.toBeNull();
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
