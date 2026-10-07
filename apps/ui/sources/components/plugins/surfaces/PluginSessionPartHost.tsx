import * as React from 'react';
import type { PluginUiSessionPartPresentation } from '@happier-dev/plugin-ui/advanced';

import {
    EmbeddedSessionComposerPart,
    EmbeddedSessionProvider,
    EmbeddedSessionStandardLayout,
    EmbeddedSessionTranscriptPart,
    type SessionViewEmbeddedPresentation,
} from '@/components/sessions/shell/embedded/EmbeddedSessionProvider';
import { EmbeddedSessionControllerClaimsScope, EmbeddedSessionStatePublication } from '@/components/sessions/shell/embedded/EmbeddedSessionParts';
import { EmbeddedSessionUnavailable } from '@/components/sessions/shell/embedded/EmbeddedSessionUnavailable';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

import { PluginSurfaceNestingBoundary } from './pluginSurfaceNesting';

/**
 * The mounted plugin surface's own facts a Session part is resolved against: its server account
 * scope (the only source of the Session's Home) and whether the mount is presented to the viewer.
 */
type PluginSessionPartMount = Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    /** Visibility and focus come from their existing, distinct presentation owners. */
    presented: boolean;
    focusEligible: boolean;
}>;

const PluginSessionPartMountContext = React.createContext<PluginSessionPartMount | null>(null);

/** Provided by the same-realm plugin mount around the plugin's tree. */
export function PluginSessionPartMountScope(props: Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    presented: boolean;
    focusEligible: boolean;
    children: React.ReactNode;
}>) {
    const value = React.useMemo(
        () => ({ accountLifetime: props.accountLifetime, presented: props.presented, focusEligible: props.focusEligible }),
        [props.accountLifetime, props.presented, props.focusEligible],
    );
    return (
        <PluginSessionPartMountContext.Provider value={value}>
            {props.children}
        </PluginSessionPartMountContext.Provider>
    );
}

/**
 * The presentation-host renderer behind plugin-ui's `SessionProvider`, `SessionTranscript`,
 * `SessionComposer` and `SessionChat` (plan 05 §4.4). A module constant, so installing it never
 * changes the presentation host's identity.
 */
export function renderPluginSessionPart(input: PluginUiSessionPartPresentation): React.ReactNode {
    switch (input.part) {
        case 'provider':
            return (
                <PluginSessionController sessionId={input.sessionId} readOnly={input.readOnly} presented={input.presented}>
                    {input.children}
                </PluginSessionController>
            );
        case 'chat':
            return (
                <PluginSessionController sessionId={input.sessionId} readOnly={input.readOnly} presented={input.presented}>
                    <EmbeddedSessionStandardLayout {...(input.testID ? { testID: input.testID } : {})} />
                </PluginSessionController>
            );
        case 'transcript':
            return <EmbeddedSessionTranscriptPart {...(input.testID ? { testID: input.testID } : {})} />;
        case 'composer':
            return <EmbeddedSessionComposerPart {...(input.testID ? { testID: input.testID } : {})} />;
    }
}

// Plugin mounts take every arm option at its default: the options are host and embed-profile
// choices, never the plugin's.
const PLUGIN_SESSION_CHAT_PRESENTATION: SessionViewEmbeddedPresentation = Object.freeze({
    kind: 'embedded',
    composer: 'auto',
});
const PLUGIN_SESSION_READ_ONLY_PRESENTATION: SessionViewEmbeddedPresentation = Object.freeze({
    kind: 'embedded',
    composer: 'none',
});

function PluginSessionController(props: Readonly<{
    sessionId: string;
    readOnly: boolean;
    presented?: boolean;
    children: React.ReactNode;
}>) {
    const mount = React.useContext(PluginSessionPartMountContext);
    // The Session's Home comes only from the mount's account scope; an author supplies nothing
    // beyond the id, so a Session on another Home is simply not found there.
    const serverId = mount?.accountLifetime?.scope.serverId?.trim() || null;
    const presented = mount?.presented === true && props.presented !== false;
    const target = React.useMemo(() => ({ kind: 'session' as const, sessionId: props.sessionId }), [props.sessionId]);
    return (
        <PluginSurfaceNestingBoundary>
            {serverId === null ? (
                <EmbeddedSessionControllerClaimsScope>
                    <EmbeddedSessionStatePublication
                        state="unavailable"
                        transcript={<EmbeddedSessionUnavailable />}
                        arrangement={props.children}
                    />
                </EmbeddedSessionControllerClaimsScope>
            ) : (
                <EmbeddedSessionProvider
                    target={target}
                    serverId={serverId}
                    presentation={props.readOnly ? PLUGIN_SESSION_READ_ONLY_PRESENTATION : PLUGIN_SESSION_CHAT_PRESENTATION}
                    surfaceFocused={presented && mount?.focusEligible === true}
                    surfaceVisible={presented}
                >
                    {props.children}
                </EmbeddedSessionProvider>
            )}
        </PluginSurfaceNestingBoundary>
    );
}
