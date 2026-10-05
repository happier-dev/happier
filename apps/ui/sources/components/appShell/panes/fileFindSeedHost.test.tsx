import { installFileFindAccountBoundaryMocks } from './fileFindSeedTestHelpers';
import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { installAppPaneScopeHostCommonModuleMocks } from '@/components/appShell/panes/appPaneScopeHostTestHelpers';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import * as findSeedHosts from './fileFindSeedHost';
import { createFileViewerFindModel } from '@/components/workspaces/files/details/useFileViewerFind';
import { openChatWithFindSeed } from './fileFindSeedHandoff';
const { FileFindSeedHost } = findSeedHosts;

installAppPaneScopeHostCommonModuleMocks();
installFileFindAccountBoundaryMocks();
const { renderScreen } = await import('@/dev/testkit');
const { act } = await import('react-test-renderer');
const { AppPaneProvider, useAppPaneContext } = await import('./AppPaneProvider');

const destination = { host: 'project' as const, id: 'project-a', path: 'src/a.ts',
    scope: { serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo' } };
const seed = { query: 'needle', options: { matchCase: false, regex: false }, target: { kind: 'file' as const, path: 'src/a.ts' } };

function Stage(props: Readonly<{ value?: typeof seed }>) {
    const handoff = useAppPaneContext().fileFindSeedHandoff;
    const value = props.value ?? seed;
    React.useLayoutEffect(() => {
        const authority = captureActiveServerAccountScopeLifetime();
        if (!authority) throw new Error('Expected real Account lifetime');
        handoff.stage({ ...destination, accountId: 'account-a' }, value, authority);
    }, [handoff, value]);
    return null;
}

function Host(props: Readonly<{ tabId: string; focused: boolean }>) {
    return <DestinationInstanceHost tabId={props.tabId} ref={{ kind: 'project', params: { workspaceRefId: 'project-a' } }}
        pathname="/projects/project-a" focused={props.focused} visible navigation={{ push() {}, replace() {}, back() {} }}>
        <FileFindSeedHost destination={destination} active>{(handoff) => React.createElement('FindSeedProbe', { tabId: props.tabId, ...handoff })}</FileFindSeedHost>
    </DestinationInstanceHost>;
}

describe('file Find destination memory', () => {
    it.each(['synchronous push', 'asynchronous navigation'])('discards a chat launch when %s fails before the host mounts', async (navigation) => {
        let open!: () => Promise<void>;
        const chatSeed = { query: 'failed needle', options: seed.options,
            target: { kind: 'route-message-id' as const, routeMessageId: 'imported-row' } };
        function Launch() {
            const handoff = useAppPaneContext().fileFindSeedHandoff;
            open = () => openChatWithFindSeed({ handoff, destination: { sessionId: 'chat-a', serverId: 'home-a' },
                seed: chatSeed, authority: captureActiveServerAccountScopeLifetime(),
                open: () => {
                    if (navigation === 'synchronous push') throw new Error('Navigation failed');
                    return Promise.reject(new Error('Navigation failed'));
                },
            });
            return null;
        }
        function ReopenedChat() {
            return <DestinationInstanceHost tabId="reopened" ref={{ kind: 'session', params: { sessionId: 'chat-a' } }}
                pathname="/session/chat-a" focused visible navigation={{ push() {}, replace() {}, back() {} }}>
                <findSeedHosts.ChatFindSeedHost sessionId="chat-a" serverId="home-a" active>{(input) => React.createElement('ChatSeedProbe', input)}</findSeedHosts.ChatFindSeedHost>
            </DestinationInstanceHost>;
        }
        const screen = await renderScreen(<AppPaneProvider><Launch /></AppPaneProvider>);
        await expect(open()).rejects.toThrow('Navigation failed');
        await screen.update(<AppPaneProvider><Launch /><ReopenedChat /></AppPaneProvider>);
        expect(screen.root.findByType('ChatSeedProbe').props.findSeed).toBeNull();
    });
    it.each(['session', 'project'] as const)('lands the %s travelling query in the real file matcher after content loads', async (host) => {
        const addressed = { ...destination, host, id: `${host}-a` };
        const addressedSeed = { ...seed, target: { ...seed.target, anchor: { kind: 'fileLine' as const, startLine: 2 } } };
        function StageAddressed() {
            const handoff = useAppPaneContext().fileFindSeedHandoff;
            React.useLayoutEffect(() => {
                const authority = captureActiveServerAccountScopeLifetime();
                if (!authority) throw new Error('Expected real Account lifetime');
                handoff.stage({ ...addressed, accountId: 'account-a' }, addressedSeed, authority);
            }, [handoff]);
            return null;
        }
        function Consumer(props: findSeedHosts.FileFindSeedHostInput & { loaded: boolean }) {
            const latest = React.useRef(props.loaded);
            latest.current = props.loaded;
            const model = React.useMemo(() => createFileViewerFindModel(() => ({ path: addressed.path,
                mode: 'file', text: latest.current ? 'needle\n😀 needle' : null })), []);
            const snapshot = React.useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
            React.useEffect(() => {
                if (props.findSeed && model.applySeed(props.findSeed)) props.consumeFindSeed();
            }, [model, props.loaded, props.findSeed, props.consumeFindSeed]);
            return React.createElement('FileFindResult', { snapshot, pendingSeed: props.findSeed });
        }
        function Journey(props: { loaded: boolean }) {
            const ref: React.ComponentProps<typeof DestinationInstanceHost>['ref'] = host === 'session'
                ? { kind: 'session' as const, params: { sessionId: addressed.id } }
                : { kind: 'project' as const, params: { workspaceRefId: addressed.id } };
            return <AppPaneProvider><StageAddressed />
                <DestinationInstanceHost tabId="addressed" ref={ref} pathname={`/${host}/${addressed.id}`}
                    focused visible navigation={{ push() {}, replace() {}, back() {} }}>
                    <FileFindSeedHost destination={addressed} active>{(input) => <Consumer {...input} loaded={props.loaded} />}</FileFindSeedHost>
                </DestinationInstanceHost>
            </AppPaneProvider>;
        }
        const screen = await renderScreen(<Journey loaded={false} />);
        expect(screen.root.findByType('FileFindResult').props.pendingSeed).toEqual(addressedSeed);
        expect(screen.root.findByType('FileFindResult').props.snapshot.open).toBe(false);
        await screen.update(<Journey loaded />);
        const result = screen.root.findByType('FileFindResult').props;
        expect(result.pendingSeed).toBeNull();
        expect(result.snapshot.query).toBe('needle');
        expect(result.snapshot.status).toEqual({ kind: 'results', current: 2, total: 2, coverage: 'complete' });
        expect(result.snapshot.lineRanges.get('f:2')).toEqual([{ start: 3, end: 9, current: true }]);
    });
    it('hands a chat query to only its focused Home and Session, and discards it when that destination closes', async () => {
        const chatSeed = { query: 'historic needle', options: seed.options, target: { kind: 'route-message-id' as const, routeMessageId: 'local:imported-row' } };
        function StageChat() {
            const handoff = useAppPaneContext().fileFindSeedHandoff;
            React.useLayoutEffect(() => {
                const authority = captureActiveServerAccountScopeLifetime();
                if (!authority) throw new Error('Expected real Account lifetime');
                handoff.stageChat({ sessionId: 'chat-a', serverId: 'home-a', accountId: 'account-a' }, chatSeed, authority);
            }, [handoff]);
            return null;
        }
        function ChatHost(props: Readonly<{ tabId: string; serverId: string; focused: boolean }>) {
            return <DestinationInstanceHost tabId={props.tabId} ref={{ kind: 'session', params: { sessionId: 'chat-a' } }}
                pathname="/session/chat-a" focused={props.focused} visible navigation={{ push() {}, replace() {}, back() {} }}>
                <findSeedHosts.ChatFindSeedHost sessionId="chat-a" serverId={props.serverId} active>{(input) => React.createElement('ChatSeedProbe', { tabId: props.tabId, ...input })}</findSeedHosts.ChatFindSeedHost>
            </DestinationInstanceHost>;
        }
        const screen = await renderScreen(<AppPaneProvider><StageChat /><ChatHost tabId="wrong-home" serverId="home-b" focused /><ChatHost tabId="hidden" serverId="home-a" focused={false} /><ChatHost tabId="selected" serverId="home-a" focused /></AppPaneProvider>);
        const probes = screen.root.findAllByType('ChatSeedProbe');
        expect(probes.map(probe => probe.props.findSeed)).toEqual([null, null, chatSeed]);
        await screen.update(<AppPaneProvider><StageChat /></AppPaneProvider>);
        await screen.update(<AppPaneProvider><StageChat /><ChatHost tabId="reopened" serverId="home-a" focused /></AppPaneProvider>);
        expect(screen.root.findByType('ChatSeedProbe').props.findSeed).toBeNull();
    });
    it('acknowledges only the seed that the destination received, never a replacement seed', async () => {
        const screen = await renderScreen(<AppPaneProvider><Stage /><Host tabId="selected" focused /></AppPaneProvider>);
        const staleAcknowledge = screen.root.findByType('FindSeedProbe').props.consumeFindSeed;
        const replacement = { ...seed, query: 'second needle' };
        await screen.update(<AppPaneProvider><Stage value={replacement} /><Host tabId="selected" focused /></AppPaneProvider>);
        await act(async () => { staleAcknowledge(); });
        expect(screen.root.findByType('FindSeedProbe').props.findSeed).toEqual(replacement);
        await act(async () => { screen.root.findByType('FindSeedProbe').props.consumeFindSeed(); });
        expect(screen.root.findByType('FindSeedProbe').props.findSeed).toBeNull();
    });
    it('seeds only the focused exact destination once and discards it when that destination closes', async () => {
        const screen = await renderScreen(<AppPaneProvider><Stage /><Host tabId="hidden" focused={false} /><Host tabId="selected" focused /></AppPaneProvider>);
        const [hidden, selected] = screen.root.findAllByType('FindSeedProbe');
        expect(hidden.props.findSeed).toBeNull();
        expect(selected.props.findSeed).toEqual(seed);
        await screen.update(<AppPaneProvider><Stage /><Host tabId="hidden" focused={false} /></AppPaneProvider>);
        await screen.update(<AppPaneProvider><Stage /><Host tabId="selected" focused /></AppPaneProvider>);
        expect(screen.root.findByType('FindSeedProbe').props.findSeed).toBeNull();
    });
});
