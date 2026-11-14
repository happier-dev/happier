import * as React from 'react';
import { useFocusEffect } from '@react-navigation/native';

import {
    mergeNewSessionHostParams,
    type NewSessionEmbeddedHost,
    type NewSessionHostDraftEntry,
    type NewSessionHostParams,
} from './newSessionHost';
import { useResolveNewSessionOrdinaryEntryRoute } from './newSessionOrdinaryEntryRoute';
import { resolveNewSessionDraftRouteIdentity } from './newSessionDraftRouteIdentity';
import {
    clearOrdinaryNewSessionPickerOrigin,
    readOrdinaryNewSessionPickerOrigin,
    subscribeNewSessionPickerReturns,
    takeNewSessionPickerReturn,
} from './newSessionPickerReturns';

function paramsForDraft(entry: NewSessionHostDraftEntry): NewSessionHostParams {
    return entry.draftOrigin ? { draftId: entry.draftId, draftOrigin: entry.draftOrigin } : { draftId: entry.draftId };
}

/**
 * The state an embedding page keeps for its New Session surface: the params the route
 * would otherwise hold, starting on a contextual draft or Home's ordinary-entry draft, and
 * the intent signal that lets closed chips stay RPC-free until the person reaches for them.
 *
 * After the surface hands its draft to a created session, the next time the page is focused it
 * starts a fresh draft with the same context, so returning never shows the draft already launched.
 */
export function useNewSessionEmbeddedHostState(initialParams?: NewSessionHostParams, options?: Readonly<{
    renewOnHandOff?: boolean;
}>): Readonly<{
    host: NewSessionEmbeddedHost;
    markDemanded: () => void;
    replaceParams: (params: NewSessionHostParams) => void;
}> {
    const resolveOrdinaryEntry = useResolveNewSessionOrdinaryEntryRoute();
    // Contextual embeds start a separate draft; ordinary Home keeps its remembered entry.
    // These are local navigation params, not a persisted draft write or machine demand.
    const freshParams = React.useCallback((): NewSessionHostParams => initialParams
        ? { ...initialParams, draftId: resolveNewSessionDraftRouteIdentity({ routeDraftId: undefined }).draftId }
        : paramsForDraft(resolveOrdinaryEntry({ forceFresh: true })), [initialParams, resolveOrdinaryEntry]);
    // The page's ordinary composer (not the shell's renewing dock) comes back to the draft that opened a picker.
    const ordinaryPage = !initialParams && options?.renewOnHandOff !== true;
    const [params, setParamsState] = React.useState<NewSessionHostParams>(() => {
        if (initialParams) return freshParams();
        const pickerOrigin = ordinaryPage ? readOrdinaryNewSessionPickerOrigin() : null;
        return pickerOrigin ? { draftId: pickerOrigin, draftOrigin: 'ordinary' } : paramsForDraft(resolveOrdinaryEntry());
    });
    const [demanded, setDemanded] = React.useState(false);
    const handedOffRef = React.useRef(false);
    const targetServerId = typeof initialParams?.spawnServerId === 'string' ? initialParams.spawnServerId : undefined;

    const setParams = React.useCallback((patch: Readonly<Record<string, unknown>>) => {
        setParamsState((current) => mergeNewSessionHostParams(current, patch));
    }, []);
    const openDraft = React.useCallback((entry: NewSessionHostDraftEntry) => {
        setParamsState(initialParams
            ? { ...initialParams, draftId: entry.draftId }
            : paramsForDraft(entry));
    }, [initialParams]);
    const renewOnHandOff = options?.renewOnHandOff === true;
    const onHandedOff = React.useCallback(() => {
        if (renewOnHandOff) {
            handedOffRef.current = false;
            setParamsState(freshParams());
        } else {
            handedOffRef.current = true;
        }
    }, [freshParams, renewOnHandOff]);
    const markDemanded = React.useCallback(() => {
        setDemanded(true);
    }, []);

    // A picker result comes back to the composer whose draft opened the picker: while it is mounted, or when its pane
    // steps back to it (UI refinements ruling 2026-11-13 15:07Z).
    const draftId = typeof params.draftId === 'string' ? params.draftId : null;
    React.useEffect(() => {
        if (!draftId) return;
        clearOrdinaryNewSessionPickerOrigin(draftId);
        const take = () => {
            const returned = takeNewSessionPickerReturn(draftId);
            if (returned) setParamsState((current) => current.draftId === draftId ? mergeNewSessionHostParams(current, returned) : current);
        };
        take();
        return subscribeNewSessionPickerReturns(take);
    }, [draftId]);

    useFocusEffect(React.useCallback(() => {
        if (!handedOffRef.current) return;
        handedOffRef.current = false;
        setParamsState(freshParams());
    }, [freshParams]));

    const host = React.useMemo<NewSessionEmbeddedHost>(() => ({
        params,
        targetServerId,
        setParams,
        openDraft,
        onHandedOff,
        demanded,
    }), [demanded, onHandedOff, openDraft, params, setParams, targetServerId]);

    return { host, markDemanded, replaceParams: setParamsState };
}
