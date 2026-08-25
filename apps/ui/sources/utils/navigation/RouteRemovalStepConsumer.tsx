import * as React from 'react';
import { NavigationContext, usePreventRemove } from '@react-navigation/native';

/**
 * The one owner of "this screen has an internal step; spend it before leaving".
 *
 * A screen that holds its own place — an embedded guest's history, a plugin app
 * page's declared page-internal Back location, an inline detail stacked over the
 * list it came from — needs the SAME thing from every way a user goes back, and
 * those ways are not one mechanism:
 *
 * - Android dispatches a hardware Back to React Native's own listener stack;
 * - iOS removes the screen through the header button or the edge-swipe gesture;
 * - a browser turns the Back button into a history pop the navigator replays;
 * - a desktop keyboard sends Escape, which is not navigation at all.
 *
 * Only the first is a `BackHandler` fact. The middle two are one fact — the
 * route is being REMOVED — and this component is the place that answers it, so
 * a screen does not grow a second per-platform Back implementation. (Escape is
 * genuinely a different owner: the app's Escape layer stack, which orders it
 * against overlays and modals the way this cannot.)
 *
 * The removal is prevented while a step remains, and the exact action React
 * Navigation was going to perform is re-dispatched when there is none, so the
 * screen never becomes a trap: `consume` returning `false` is "I have no step",
 * and the user leaves on that same press.
 *
 * It renders nothing and owns no route. `usePreventRemove` requires a navigator
 * in scope, so the hook lives one component down from the null check rather than
 * being called conditionally.
 */
export function RouteRemovalStepConsumer(props: Readonly<{
    /** Only a screen that currently holds a step should intercept removal. */
    active: boolean;
    /**
     * Spend one internal step.
     *
     * `true` means the step was spent and the user must stay; `false` means the
     * screen has none and the removal proceeds unchanged. It is never "handled,
     * but nothing visible happened".
     */
    consume: () => boolean;
}>): React.ReactElement | null {
    const navigation = React.useContext(NavigationContext);
    if (!props.active || navigation == null) return null;
    return (
        <ActiveRouteRemovalStepConsumer
            navigation={navigation as RouteNavigationDispatch}
            consume={props.consume}
        />
    );
}

type RouteNavigationDispatch = Readonly<{
    dispatch?: (action: unknown) => void;
}>;

function ActiveRouteRemovalStepConsumer(props: Readonly<{
    navigation: RouteNavigationDispatch;
    consume: () => boolean;
}>): null {
    const [pendingRouteAction, setPendingRouteAction] = React.useState<unknown | null>(null);
    const consumeRef = React.useRef(props.consume);
    consumeRef.current = props.consume;
    const handlePreventedRemove = React.useCallback((event: Readonly<{
        data: Readonly<{ action: unknown }>;
    }>) => {
        if (consumeRef.current()) return;
        setPendingRouteAction(event.data.action);
    }, []);
    usePreventRemove(pendingRouteAction === null, handlePreventedRemove);

    React.useEffect(() => {
        if (pendingRouteAction === null) return;
        // `usePreventRemove` sees disabled before this effect redispatches the
        // declined action, so route ownership resumes without recursive guard.
        setPendingRouteAction(null);
        props.navigation.dispatch?.(pendingRouteAction);
    }, [pendingRouteAction, props.navigation]);
    return null;
}
