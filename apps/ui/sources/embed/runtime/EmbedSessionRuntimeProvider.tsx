import * as React from 'react';
import { useRouter } from 'expo-router';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { createEmbedEncryption } from '@/embed/encryption/createEmbedEncryption';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { bootstrapActiveServerFromWebLocation } from '@/sync/domains/server/url/bootstrapActiveServerFromWebLocation';
import { createEmbedSessionRuntime } from './createEmbedSessionRuntime';
import { EmbedRuntimeStateSurface } from '@/embed/state/EmbedRuntimeStateSurface';
import type { EmbedSessionRuntime, EmbedSessionRuntimeSnapshot } from './createEmbedSessionRuntime';

const Context = React.createContext<Readonly<{ runtime: EmbedSessionRuntime; snapshot: EmbedSessionRuntimeSnapshot }> | null>(null);

/** The page owns recipient material; changing a Session never creates another root key pair. */
export function EmbedSessionRuntimeProvider(props: Readonly<{ children: React.ReactNode; endpointUrl?: string }>) {
    const router = useRouter();
    const routerRef = React.useRef(router);
    routerRef.current = router;
    const [runtime, setRuntime] = React.useState<EmbedSessionRuntime | null>(null);
    const [pageActive, setPageActive] = React.useState(true);
    const pageActiveRef = React.useRef(true);
    const rootRef = React.useRef<EmbedSessionRuntime | null>(null);
    const [bootError, setBootError] = React.useState(false);
    React.useEffect(() => {
        if (typeof window === 'undefined') return;
        const hide = () => {
            pageActiveRef.current = false;
            rootRef.current?.dispose();
            rootRef.current = null;
            setRuntime(null);
            setPageActive(false);
        };
        const show = () => {
            pageActiveRef.current = true;
            setPageActive(true);
        };
        window.addEventListener('pagehide', hide);
        window.addEventListener('pageshow', show);
        return () => {
            window.removeEventListener('pagehide', hide);
            window.removeEventListener('pageshow', show);
        };
    }, []);
    React.useEffect(() => {
        if (!pageActive) return;
        let canceled = false;
        let root: EmbedSessionRuntime | null = null;
        setRuntime(null);
        setBootError(false);
        const navigate = (sessionId: string | null) => {
            const search = typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search);
            const identity = {
                ...(search.has('i') ? { i: search.get('i')! } : {}),
                ...(search.has('n') ? { n: search.get('n')! } : {}),
                ...(search.has('server') ? { server: search.get('server')! } : {}),
            };
            routerRef.current.replace(sessionId === null
                ? { pathname: '/embed/new', params: identity }
                : { pathname: '/embed/session/[id]', params: { ...identity, id: sessionId } });
        };
        void (async () => {
            if (!props.endpointUrl) {
                await bootstrapActiveServerFromWebLocation({ scope: 'device', activateUnknownInIsolatedRealm: true });
            }
            const endpointUrl = props.endpointUrl ?? getActiveServerSnapshot().serverUrl;
            return { encryption: await createEmbedEncryption(), endpointUrl };
        })().then(({ encryption, endpointUrl }) => {
            if (canceled || !pageActiveRef.current) { encryption.dispose(); return; }
            root = createEmbedSessionRuntime({ encryption, endpointUrl, navigate });
            rootRef.current = root;
            setRuntime(root);
        }).catch(() => {
            if (!canceled && pageActiveRef.current) setBootError(true);
        });
        return () => {
            canceled = true;
            root?.dispose();
            if (rootRef.current === root) rootRef.current = null;
        };
    }, [pageActive, props.endpointUrl]);
    return runtime ? <MountedRuntime runtime={runtime}>{props.children}</MountedRuntime>
        : bootError ? <EmbedRuntimeStateSurface phase="error" error="credential_unavailable" /> : null;
}

function MountedRuntime(props: Readonly<{ runtime: EmbedSessionRuntime; children: React.ReactNode }>) {
    const snapshot = React.useSyncExternalStore(props.runtime.subscribe, props.runtime.getSnapshot, props.runtime.getSnapshot);
    const value = React.useMemo(() => ({ runtime: props.runtime, snapshot }), [props.runtime, snapshot]);
    return (
        <Context.Provider value={value}>
            <InjectedAuthProvider credentials={snapshot.credential}>
                {props.children}
            </InjectedAuthProvider>
        </Context.Provider>
    );
}

export function useEmbedSessionRuntime(): Readonly<{ runtime: EmbedSessionRuntime; snapshot: EmbedSessionRuntimeSnapshot }> {
    const value = React.useContext(Context);
    if (!value) throw new Error('Embed runtime is unavailable');
    return value;
}
