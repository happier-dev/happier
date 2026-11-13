import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { ShareSheet } from './ShareSheet';
import { t } from '@/text';
import { createDocumentShareAdapter } from './documents/documentShareAdapter';
import { buildShareSheetSelectionStep } from './buildShareSheetSelectionStep';
import type { ShareSheetActions, ShareSheetModel } from './shareSheetTypes';
import { DisclosureCaret } from '@/components/ui/lists/DisclosureCaret';
import { ArtifactAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { presentSharePrincipal } from './sharePrincipalPresentation';

const routerPush = vi.hoisted(() => vi.fn());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { push: routerPush } }).module);

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
    it('keeps a selected grant while folded directories become searched asynchronous results across kinds', async () => {
        const chosen = presentSharePrincipal({ ref: { kind: 'account', accountId: 'chosen' }, name: 'Shared person' });
        const candidate = presentSharePrincipal({ ref: { kind: 'account', accountId: 'other' }, name: 'Shared colleague' });
        const candidates = [candidate,
            presentSharePrincipal({ ref: { kind: 'team', teamId: 'design' }, name: 'Shared Team' }),
            presentSharePrincipal({ ref: { kind: 'group', teamId: 'design', groupId: 'editors' }, name: 'Shared Group' }),
        ];
        const state: ShareSheetModel = { ...model, grants: [{
            grant: chosen.ref, principal: chosen, level: { kind: 'editable', value: 'view', options: ['view'] },
            removal: { kind: 'allowed' }, operation: { kind: 'idle' },
        }], directory: { query: '', sections: candidates.map(candidate => ({
            kind: candidate.ref.kind, title: candidate.ref.kind, status: 'idle', candidates: [],
            cursor: null, hasMore: false, loadingMore: false,
            resolveCandidates: async () => (candidate.ref.kind === 'account' ? [chosen, candidate] : [candidate]).map(principal => ({
                principal, addition: { kind: 'allowed' as const }, operation: { kind: 'idle' as const },
            })),
        })) } };
        const build = (query: string, revealSuggestions: boolean) => buildShareSheetSelectionStep({
            model: { ...state, directory: { ...state.directory, query } }, actions, adapter,
            presentation: 'full', idPrefix: '', onExpand: noop, revealSuggestions,
        });
        const collapsed = build('', false);
        expect(collapsed.sections.some(section => section.id === 'directory-controls')).toBe(true);
        const searched = build('shared', true);
        for (const step of [collapsed, searched]) {
            const grants = step.sections.filter(section => section.kind === 'static')
                .flatMap(section => section.options).filter(option => option.id === chosen.key);
            expect(grants).toHaveLength(1);
            expect(grants[0]?.label).toBe(chosen.displayName);
        }
        const directories = searched.sections.filter(section => section.kind === 'dynamic');
        expect(directories).toHaveLength(3);
        for (const directory of directories) {
            const result = await directory.resolve('shared', new AbortController().signal);
            // Directories are presented account, group, team by their canonical order.
            const expected = candidates.find(candidate => directory.id === `directory:${candidate.ref.kind}`);
            expect(expected).toBeDefined();
            expect(result.options.map(option => option.id)).toEqual([expected!.key]);
        }
        expect(build('', false).sections.map(section => section.id)).toEqual(collapsed.sections.map(section => section.id));
    });
    it('keeps browse entries above asynchronous suggestions', () => {
        const step = buildShareSheetSelectionStep({ model: { ...model, directory: { query: '', sections: [{
            kind: 'account', title: 'People', status: 'idle', candidates: [], cursor: null, hasMore: false,
            loadingMore: false, resolveCandidates: async () => [],
        }] } }, actions, adapter, presentation: 'full', idPrefix: '', onExpand: noop });
        expect(step.sections.findIndex(section => section.id.startsWith('directory-controls')))
            .toBeLessThan(step.sections.findIndex(section => section.id === 'directory:account'));
    });

    it.each(['team', 'group'] as const)('keeps lazy %s browsing reachable until an empty directory resolves', async (kind) => {
        vi.useFakeTimers();
        let reads = 0;
        function DirectorySheet({ ownsTeam }: { ownsTeam: boolean }) {
            const [resolved, setResolved] = React.useState(false);
            const rows = React.useMemo(() => ownsTeam ? [{
                principal: presentSharePrincipal({ ref: kind === 'team'
                    ? { kind: 'team', teamId: 'design' } : { kind: 'group', teamId: 'design', groupId: 'editors' }, name: 'Design' }),
                addition: { kind: 'allowed' as const }, operation: { kind: 'idle' as const },
            }] : [], [ownsTeam]);
            const resolve = React.useCallback(async () => { reads++; setResolved(true); return rows; }, [rows]);
            return <ShareSheet model={{ ...model, directory: { query: '', sections: [{
                kind, title: kind === 'team' ? 'Teams' : 'Groups', status: 'idle', candidates: resolved ? rows : [],
                resolved, cursor: null, hasMore: false, loadingMore: false, resolveCandidates: resolve,
            }] } }} actions={actions} adapter={adapter} presentation="inline" testID="document-share-editor" />;
        }
        for (const ownsTeam of [true, false]) {
            const screen = await renderScreen(<DirectorySheet ownsTeam={ownsTeam} />);
            await flushHookEffects({ runOnlyPendingTimers: true });
            expect(reads).toBe(0);
            expect(screen.findByTestId(`document-share-browse:${kind}`)).not.toBeNull();
            await screen.pressByTestIdAsync(`document-share-browse:${kind}`);
            await flushHookEffects({ runOnlyPendingTimers: true });
            expect(reads).toBeGreaterThan(0);
            if (ownsTeam) expect(screen.getTextContent()).toContain('Design');
            // Return to the root with the settled directory projection.
            await screen.update(<ShareSheet model={{ ...model, directory: { query: '', sections: [{
                kind, title: 'Directory', status: 'idle', candidates: [], resolved: true,
                cursor: null, hasMore: false, loadingMore: false, resolveCandidates: async () => [],
            }] } }} actions={actions} adapter={adapter} presentation="inline" testID="document-share-editor" />);
            if (!ownsTeam) expect(screen.findByTestId(`document-share-browse:${kind}`)).toBeNull();
            await screen.unmount();
            reads = 0;
        }
    });
    it('renders reported template versions on their existing recipient rows and distinguishes no report from unavailable', async () => {
        const grant = { accessLevel: 'view', createdByAccountId: 'author', createdAt: 1 };
        const response = ArtifactAccessGrantsListResponseV1Schema.parse({ artifactId: 'template', ownerAccountId: 'author', access: 'owner', grants: [
            { ...grant, principal: { kind: 'account', accountId: 'maya' }, display: { name: 'Maya' }, acceptedVersions: [
                { version: '1.0.0', copies: 2, reportedAt: 100 }, { version: '2.0.0', copies: 1, reportedAt: 200 },
            ] },
            { ...grant, principal: { kind: 'account', accountId: 'nora' }, display: { name: 'Nora' }, acceptedVersions: [] },
            { ...grant, principal: { kind: 'account', accountId: 'alex' }, display: { name: 'Alex' } },
            { ...grant, principal: { kind: 'team', teamId: 'design' }, display: { name: 'Design' } },
        ] });
        const roster: ShareSheetModel = { ...model, grants: response.grants.map(row => ({
            grant: row.principal, principal: presentSharePrincipal({ ref: row.principal, name: row.display.name }),
            level: { kind: 'editable', value: row.accessLevel, options: ['view'] },
            removal: { kind: 'allowed' }, operation: { kind: 'idle' },
        })) };
        const templateAdapter = createDocumentShareAdapter({ artifactId: response.artifactId, kind: 'bot_template.v1',
            grants: response.grants, loading: false, readOnly: false, retryContent: noop });
        const screen = await renderScreen(<ShareSheet model={roster} actions={actions}
            adapter={templateAdapter} presentation="full" testID="document-share-editor" />);
        expect(screen.getTextContent()).toContain('Last reported 1.0.0 · copies: 2');
        expect(screen.getTextContent()).toContain('Last reported 2.0.0 · copies: 1');
        const step = buildShareSheetSelectionStep({ model: roster, actions, adapter: templateAdapter,
            presentation: 'full', onExpand: noop, idPrefix: '' });
        const current = step.sections.find(section => section.id === 'current');
        if (current?.kind !== 'static') throw new Error('Expected existing recipient rows');
        const rows = new Map(current.options.map(option => [option.id, option]));
        expect(rows.get('account:maya')?.accessibilityLabel).toContain('1.0.0');
        expect(rows.get('account:nora')?.subtitle).toBe('No version reported');
        expect(rows.get('account:alex')?.subtitle).toBe('Version reports unavailable');
        expect(rows.get('team:design')?.subtitle).toContain('Version reports unavailable');
        expect(rows.get('team:design')?.subtitle).not.toContain('1.0.0');
        await screen.pressByTestIdAsync('document-share-grant-account:maya');
        expect(screen.findByTestId('document-share-version-reports:account:maya')).not.toBeNull();

        await screen.update(<ShareSheet model={roster} actions={actions} adapter={adapter}
            presentation="full" testID="document-share-editor" />);
        expect(screen.getTextContent()).not.toContain('Last reported');
        expect(screen.getTextContent()).not.toContain('Version reports unavailable');
    });
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
    it('puts Remove on a recipient row when the sheet has only one level, without opening the row first', async () => {
        const requestRemove = vi.fn();
        const oneLevel = { ...adapter, levels: { view: { label: 'Give them the value' } }, showsLevelLock: () => true };
        const roster: ShareSheetModel = { ...model, grants: [{
            grant: { kind: 'account', accountId: 'bob' },
            principal: { ref: { kind: 'account', accountId: 'bob' }, key: 'account:bob', displayName: 'Bob', accessibilityLabel: 'Bob' },
            level: { kind: 'locked', value: 'view', reason: { code: 'one_level', message: 'One level' } },
            removal: { kind: 'allowed' }, operation: { kind: 'idle' },
        }] };
        const screen = await renderScreen(<ShareSheet model={roster} actions={{ ...actions, requestRemove }}
            adapter={oneLevel} presentation="inline" testID="secret-share" />);
        // The level is the same for everyone, so the row's one control is Remove, visible at rest.
        expect(screen.findByTestId('secret-share:document-share-level:account:bob')).toBeNull();
        await screen.pressByTestIdAsync('secret-share:document-share-remove:account:bob');
        expect(requestRemove).toHaveBeenCalledWith({ kind: 'account', accountId: 'bob' });
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
    it('keeps a searched people directory one Browse away while a query is typed and after it is cleared', () => {
        // The people directory is a server search: a typed query that matches no one leaves no further page
        // for that query, but everyone else is still there to browse (OPUS5-B: Browse all people vanished).
        const searched = (query: string): ShareSheetModel => ({ ...model, directory: { query, sections: [{
            kind: 'account', title: 'People', status: 'idle', cursor: null, hasMore: false, loadingMore: false, candidates: [],
            resolveCandidates: async () => [] }] } });
        const optionIds = (value: ShareSheetModel) => buildShareSheetSelectionStep({ model: value, actions, adapter, presentation: 'full',
            onExpand: noop, idPrefix: '', revealSuggestions: true }).sections.flatMap(section => section.kind === 'static'
            ? section.options.map(option => option.id) : []);
        expect(optionIds(searched('qa-th'))).toContain('browse:account');
        expect(optionIds(searched(''))).toContain('browse:account');
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

    it('says who a typed search can reach and leads to connecting when no one matches', async () => {
        const searched = (query: string): ShareSheetModel => ({ ...model, directory: { query, sections: [{
            kind: 'account', title: 'People', status: 'idle', cursor: null, hasMore: false, loadingMore: false, candidates: [],
            resolveCandidates: async () => [] }] } });
        const resolvePeople = async (query: string) => {
            const section = buildShareSheetSelectionStep({ model: searched(query), actions, adapter, presentation: 'compact',
                onExpand: noop, idPrefix: '', revealSuggestions: true }).sections.find(entry => entry.id === 'directory:account');
            if (section?.kind !== 'dynamic') throw new Error('people suggestions missing');
            return (await section.resolve(query, new AbortController().signal)).options;
        };
        // Before anything is typed an empty suggestion list stays quiet (the Browse step explains the directory).
        expect(await resolvePeople('')).toEqual([]);
        const [empty, ...rest] = await resolvePeople('zed');
        expect(rest).toEqual([]);
        expect(empty?.label).toBe(t('shareSheet.noMatchingPeople', { query: 'zed' }));
        const screen = await renderScreen(<>{empty?.content}</>);
        expect(screen.getTextContent()).toContain(t('shareSheet.noMatchingPeople', { query: 'zed' }));
        await screen.pressByTestIdAsync('document-share-search-empty-find-friends');
        expect(routerPush).toHaveBeenCalledWith('/friends');
    });
    it('does not ask to connect first when the search only finds someone who already has access', async () => {
        const bob = { ref: { kind: 'account', accountId: 'bob' }, key: 'account:bob', displayName: 'Bob', accessibilityLabel: 'Bob' } as const;
        const added: ShareSheetModel = { ...model, grants: [{
            grant: { kind: 'account', accountId: 'bob' }, principal: bob,
            level: { kind: 'editable', value: 'view', options: ['view'] }, removal: { kind: 'allowed' }, operation: { kind: 'idle' },
        }], directory: { query: 'Bob', sections: [{
            kind: 'account', title: 'People', status: 'idle', cursor: null, hasMore: false, loadingMore: false, candidates: [],
            resolveCandidates: async () => [{ principal: bob, addition: { kind: 'allowed' }, operation: { kind: 'idle' } }] }] } };
        const section = buildShareSheetSelectionStep({ model: added, actions, adapter, presentation: 'compact',
            onExpand: noop, idPrefix: '', revealSuggestions: true }).sections.find(entry => entry.id === 'directory:account');
        if (section?.kind !== 'dynamic') throw new Error('people suggestions missing');
        const options = (await section.resolve('Bob', new AbortController().signal)).options;
        expect(options.map(option => option.label)).not.toContain(t('shareSheet.noMatchingPeople', { query: 'Bob' }));
    });
    it('opens and closes the Details disclosure in place with the turning caret rows use elsewhere', async () => {
        const screen = await renderScreen(<ShareSheet model={model} actions={actions}
            adapter={adapter} presentation="full" testID="document-share-editor" />);
        const caret = () => screen.findAllByType(DisclosureCaret).map(node => node.props.expanded as boolean);
        expect(caret()).toEqual([false]);
        expect(screen.findByTestId('document-share-help-content')).toBeNull();
        await screen.pressByTestIdAsync('document-share-help');
        expect(caret()).toEqual([true]);
        expect(screen.findByTestId('document-share-help-content')).not.toBeNull();
        await screen.pressByTestIdAsync('document-share-help');
        expect(caret()).toEqual([false]);
        expect(screen.findByTestId('document-share-help-content')).toBeNull();
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
