import * as React from 'react';
import { sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { SessionCollaborationHandoff } from '@/components/sessions/collaboration/sessionCollaborationIntent';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { SessionAccessEditor } from './SessionAccessEditor';
import { UnboundSessionHomeScopeCard } from './UnboundSessionHomeScopeCard';
import { useLiveSessionAccessEditorController } from './useLiveSessionAccessEditorController';
import { storage } from '@/sync/domains/state/storage';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { readSessionMetadataLayoutVersion } from '@/sync/engine/sessions/parsePlainSessionPayload';
import type { SessionAccessEditorPresentation } from './sessionAccessEditorTypes';
import { useSessionViewShellSession } from '@/components/sessions/shell/sessionViewStableSession';

function ScopedEditor(props: Readonly<{scope:ServerAccountScope;sessionId:string;presentation:SessionAccessEditorPresentation;onRequestClose?:()=>void;onOpenFullSurface?:(handoff:SessionCollaborationHandoff)=>void;testID?:string}>) {
    // The composer host holds no exact snapshot; the canonical Home-scoped row is
    // its projection of this Session. A missing row leaves the layout unknown.
    const metadataLayoutVersion=storage((state)=>{
        const row=readSessionListRowForServerId(state.sessionListRowsByServerId,props.scope.serverId,props.sessionId);
        return row?readSessionMetadataLayoutVersion(row.metadataLayoutVersion):null;
    });
    const controller=useLiveSessionAccessEditorController({scope:props.scope,sessionId:props.sessionId,metadataLayoutVersion});
    const session = useSessionViewShellSession(props.sessionId, props.scope.serverId);
    return <SessionAccessEditor {...controller} presentation={props.presentation} onRequestClose={props.onRequestClose}
        templateSource={session ? { session, serverId: props.scope.serverId } : undefined}
        onOpenFullSurface={props.onOpenFullSurface} linkPath={buildScopedSessionRouteHref({sessionId:props.sessionId})} testID={props.testID}/>;
}

/** Lazy composer host; exact Account resolution starts only when its popover mounts. */
export function LiveSessionAccessEditor(props:Readonly<{target:SessionAddress;presentation:SessionAccessEditorPresentation;onRequestClose?:()=>void;onOpenFullSurface?:(handoff:SessionCollaborationHandoff)=>void;testID?:string}>) {
    const resolution=useServerCredentialAccountScopeResolution(props.target.serverId);
    if(resolution.kind!=='bound'){
        return <UnboundSessionHomeScopeCard resolution={resolution} serverId={props.target.serverId} testIDPrefix="session-access-editor"/>;
    }
    const {scope}=resolution;
    const editorKey = JSON.stringify([
        scope.accountId,
        sessionAddressKey({ serverId: scope.serverId, sessionId: props.target.sessionId }),
    ]);
    return <ScopedEditor key={editorKey} scope={scope} sessionId={props.target.sessionId} presentation={props.presentation}
        onRequestClose={props.onRequestClose} onOpenFullSurface={props.onOpenFullSurface} testID={props.testID}/>;
}
