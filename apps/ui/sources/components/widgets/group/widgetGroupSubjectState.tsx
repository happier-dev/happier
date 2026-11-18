import * as React from 'react';

import { WidgetFrameBodySubjectStateContext } from '@/components/widgets/frame/widgetFrameBodyCaption';

/** A group's lending slot: a widget that follows the group's value lends its subject state under its id. */
export const WidgetGroupSubjectStateContext = React.createContext<((instanceId: string, state: string | null) => void) | null>(null);

/**
 * The state of what a titled group's widgets follow, said once in its header (O2, WAVE-ACCEPT-1118D): each widget
 * that follows the group's value lends its words ("Offline · Last seen 4 days ago"), and the header shows them while
 * any of them still does. Widgets that follow one value say the same state, so the first lent words stand for all.
 */
export function useWidgetGroupSubjectState(): Readonly<{ state: string | null; lend: (instanceId: string, state: string | null) => void }> {
    const [states, setStates] = React.useState<ReadonlyMap<string, string>>(() => new Map());
    const lend = React.useCallback((instanceId: string, state: string | null) => setStates(previous => {
        if ((previous.get(instanceId) ?? null) === state) return previous;
        const next = new Map(previous);
        if (state === null) next.delete(instanceId);
        else next.set(instanceId, state);
        return next;
    }), []);
    const state = states.values().next().value ?? null;
    return { state, lend };
}

/**
 * One widget in a group. When the group header names the value this widget follows, the widget's body lends its
 * subject state to that header and learns the header says it; otherwise the body keeps saying it itself.
 */
export function WidgetGroupSubjectStateScope(props: Readonly<{ instanceId: string; follows: boolean; children: React.ReactNode }>) {
    const lendToGroup = React.useContext(WidgetGroupSubjectStateContext);
    const takes = props.follows && lendToGroup !== null;
    const [lent, setLent] = React.useState<string | null>(null);
    const { instanceId } = props;
    React.useEffect(() => {
        if (!takes || lendToGroup === null) return;
        lendToGroup(instanceId, lent);
        return () => lendToGroup(instanceId, null);
    }, [instanceId, lendToGroup, lent, takes]);
    const value = React.useMemo(() => (takes ? { lend: setLent, saidAbove: lent !== null } : null), [lent, takes]);
    return <WidgetFrameBodySubjectStateContext.Provider value={value}>{props.children}</WidgetFrameBodySubjectStateContext.Provider>;
}
