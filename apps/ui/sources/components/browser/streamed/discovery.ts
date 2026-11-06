import type { BrowserDaemonViewV1 } from '@happier-dev/protocol/browser/control/v1';
import type { BrowserEventV1 } from '@happier-dev/protocol/browser/events/v1';

import { resolveBrowserDaemonStreamTarget } from '@/sync/domains/browser/store';
import { areSnapshotProjectionsEquivalent, retainKeyedRows } from '@/sync/domains/state/structuralSharing';

function discoveryOpening(view: BrowserDaemonViewV1, target: NonNullable<ReturnType<typeof resolveBrowserDaemonStreamTarget>>) {
    const opened = view.events.find(event => event.kind === 'viewOpened'
        && event.browserSessionId === view.browserSessionId && event.viewId === view.viewId);
    // Capture identity selects the renderer; the daemon still owns semantic target support
    // and every adapter capability.
    return opened?.kind === 'viewOpened' ? { ...opened, target } : null;
}

function openingBindingFacts(event: Extract<BrowserEventV1, { kind: 'viewOpened' }>) {
    const { eventId: _eventId, occurredAt: _occurredAt, currentUrl: _currentUrl,
        currentUrlExpiresAt: _currentUrlExpiresAt, navigationGeneration: _navigationGeneration, ...binding } = event;
    return binding;
}

/** Discovery resumes from the delivered snapshot instead of replaying retained history. */
export function reconcileBrowserDiscovery(
    previous: readonly BrowserDaemonViewV1[] | undefined,
    incoming: readonly BrowserDaemonViewV1[],
): Readonly<{ views: readonly BrowserDaemonViewV1[]; events: readonly BrowserEventV1[] }> {
    const views = retainKeyedRows(previous, incoming, view => view.sourceId);
    const previousBySource = new Map(previous?.map(view => [view.sourceId, view]));
    const events: BrowserEventV1[] = [];
    for (const candidate of views) {
        const retained = previousBySource.get(candidate.sourceId);
        if (candidate === retained) continue;
        const target = resolveBrowserDaemonStreamTarget(candidate);
        if (!target) continue;
        // A view without a capture source has not yet been admitted to this streamed surface.
        const baselineTarget = retained && resolveBrowserDaemonStreamTarget(retained);
        const baseline = baselineTarget ? retained : undefined;
        const opening = discoveryOpening(candidate, target);
        const previousOpening = baseline && baselineTarget ? discoveryOpening(baseline, baselineTarget) : null;
        if (opening && (!previousOpening || !areSnapshotProjectionsEquivalent(openingBindingFacts(previousOpening),
            openingBindingFacts(opening)))) events.push(opening);
        // Event sequences can restart with the daemon adapter. Reconcile the event facts through
        // the structural-sharing owner rather than treating an id alone as unchanged content.
        const delivered = new Set(baseline?.events);
        for (const event of retainKeyedRows(baseline?.events, candidate.events, event => event.eventId)) {
            if (event.kind !== 'viewOpened' && !delivered.has(event)
                && event.browserSessionId === candidate.browserSessionId
                && (!('viewId' in event) || event.viewId === candidate.viewId)) events.push(event);
        }
    }
    return { views, events };
}

/** Live navigation advances the same snapshot that the next discovery will reconcile against. */
export function applyBrowserDiscoveryEvent(
    views: readonly BrowserDaemonViewV1[],
    event: BrowserEventV1,
): readonly BrowserDaemonViewV1[] {
    if (event.kind !== 'navigationStateChanged') return views;
    return retainKeyedRows(views, views.map(view => view.browserSessionId === event.browserSessionId && view.viewId === event.viewId
        ? { ...view, events: [...view.events.filter(previous => previous.kind !== event.kind), event] }
        : view), view => view.sourceId);
}
