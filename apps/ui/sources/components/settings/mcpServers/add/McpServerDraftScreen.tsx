import { useAuthoringDraftExitGuard } from '@/utils/navigation/useAuthoringDraftExitGuard';
import * as React from 'react';
import { useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { MCP_COLLECTION_ROUTE, mcpServerRoute } from '../collection/mcpServerCollectionModel';
import { useMcpServersSettings } from '../useMcpServersSettings';
import { McpCustomInput } from './McpCustomInput';
import { useMcpAddBinding, useMcpDraftDirty, useMcpServerDraft } from './useMcpServerDraft';
import { useMcpAddPlaces } from './useMcpAddPlaces';

export function McpServerDraftScreen(): React.ReactElement {
    const router = useRouter();
    const navigation = useNavigation() as Readonly<{ dispatch?: (action: unknown) => void; setOptions?: (options: { gestureEnabled: boolean }) => void }>;
    const catalog = useMcpServersSettings();
    const draft = useMcpServerDraft(catalog, useMcpAddBinding(catalog.scope));
    const places = useMcpAddPlaces();
    const dirty = useMcpDraftDirty(draft);
    const dirtyRef = React.useRef(dirty);
    dirtyRef.current = dirty;
    const discard = React.useCallback(() => { draft.reset(); dirtyRef.current = false; }, [draft.reset]);
    const save = React.useCallback(async () => (await draft.create()) !== null, [draft.create]);
    const continueNavigation = React.useCallback((action: unknown) => {
        if (action && navigation.dispatch) navigation.dispatch(action);
        else router.replace(MCP_COLLECTION_ROUTE);
    }, [navigation.dispatch, router]);
    const guard = useAuthoringDraftExitGuard({ isDirty: dirty, isDirtyRef: dirtyRef, onDiscard: discard, onSave: save, onContinue: continueNavigation });
    React.useEffect(() => {
        navigation.setOptions?.({ gestureEnabled: !dirty });
        return () => navigation.setOptions?.({ gestureEnabled: true });
    }, [dirty, navigation.setOptions]);
    const onCreated = React.useCallback((id: string) => {
        guard.ignoreRef.current = true;
        dirtyRef.current = false;
        router.replace(mcpServerRoute(id) as never);
    }, [guard.ignoreRef, router]);
    return <McpCustomInput draft={draft} approval={catalog.approval} places={places} publishTitle onCreated={onCreated}
        onDiscard={() => { void Promise.resolve(guard.requestExit()).then(allowed => { if (allowed) router.replace(MCP_COLLECTION_ROUTE); }); }} />;
}
