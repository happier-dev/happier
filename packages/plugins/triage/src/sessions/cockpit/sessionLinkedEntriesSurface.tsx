import * as React from 'react';
import type { RenderContext, RenderSurface } from '@happier-dev/plugin-sdk/ui';
import {
    Banner,
    Button,
    EmptyState,
    ErrorState,
    List,
    LoadingState,
    Screen,
    Stack,
    defineUiSurface,
    usePluginHostApi,
    usePluginTranslation,
    useSurfaceContext,
} from '@happier-dev/plugin-ui';

import { TRIAGE_DISPLAY_NAME } from '../../displayName.js';
import type { TriageSessionLinkedEntryRowV1 } from './linkedEntryRows.js';
import { useTriageDurableAccount } from '../../ui/durable/accountDurableState.js';
import {
    createActionTriageUnlinkTransport,
    createDirectTriageUnlinkTransport,
    type TriageUnlinkTransportV1,
} from './unlinkLinkedEntry.js';
import { useTriageSessionLinkedEntries } from './useSessionLinkedEntries.js';

/**
 * The Session-targeted linked-entries surface.
 *
 * It is one ordinary Session-targeted view, not a Triage-shaped host contract.
 * The incumbent right-sidebar Registry entry mounts it on desktop, classic
 * mobile opens the same right-sidebar panel, and the mobile cockpit derives its
 * full-screen plugin surface from that same Registry entry. Nothing in this file
 * knows which of the three it is in: Triage declares no mobile view, cockpit
 * destination, host tab union member, route or platform branch, so what varies
 * across the three comes from the contribution and the responsive shared
 * components, never from a branch here or in the host.
 *
 * The Session it reads is the exact mounted `surface.target.sessionId` and
 * nothing else — never a launch input, route value, title lookup, active or
 * focused Session, or a value taken out of a Message.
 */

function rowTitle(
    row: TriageSessionLinkedEntryRowV1,
    text: (key: string, fallback?: string) => string,
): string {
    switch (row.presentation.kind) {
        case 'linked':
            return row.presentation.displayPath;
        case 'reading':
            return text('plugins.triage.sessionLinks.reading', 'Reading this link…');
        case 'unlinked':
            return text('plugins.triage.sessionLinks.removed', 'This link was removed.');
        default:
            return text('plugins.triage.sessionLinks.unreadable', 'This link could not be read.');
    }
}

function rowTone(row: TriageSessionLinkedEntryRowV1): 'neutral' | 'muted' | 'warning' {
    switch (row.presentation.kind) {
        case 'linked':
            return 'neutral';
        case 'unreadable':
            return 'warning';
        default:
            return 'muted';
    }
}

/**
 * One linked row, and the one write this whole surface can make.
 *
 * **Unlink** is the inverse the reader was missing: somebody who started a
 * Session from the wrong entry had no way to undo it, and a link is durable
 * Account state that nothing else removes. It is offered only on a row that
 * actually resolved to a link, because that is the only state carrying the
 * entry reference the removal is addressed by — a row still being read, already
 * removed, or unreadable has nothing to name.
 *
 * The state here is transient and per row: no local removed set and no
 * optimistic commitment. After a settled removal the pager re-reads, and what
 * the reader sees is what the Account says.
 */
function LinkedEntryRow(props: Readonly<{
    row: TriageSessionLinkedEntryRowV1;
    sessionId: string;
    onUnlinked: () => void;
}>): React.ReactElement {
    const { row, sessionId, onUnlinked } = props;
    const text = usePluginTranslation();
    const host = usePluginHostApi();
    const durable = useTriageDurableAccount();
    // One owner, two transports. Direct `session-links` when this mount can
    // reach the Account — which is what keeps Unlink working while no daemon
    // is — and the published Action otherwise.
    const transport = React.useMemo<TriageUnlinkTransportV1>(
        () => durable.collections
            ? createDirectTriageUnlinkTransport(durable.collections)
            : createActionTriageUnlinkTransport(host),
        [durable.collections, host],
    );
    const [phase, setPhase] = React.useState<'idle' | 'removing' | 'failed'>('idle');
    const presentation = row.presentation;
    const entryRef = presentation.kind === 'linked' ? presentation.entryRef : null;

    const unlink = React.useCallback(() => {
        if (entryRef === null) return;
        setPhase('removing');
        void (async () => {
            try {
                const result = await transport.unlink({ sessionId, entryRef });
                // `conflict` means another writer moved the row, so the honest
                // next step is the same one a removal takes: re-read.
                if (result.status === 'failed') {
                    setPhase('failed');
                    return;
                }
                setPhase('idle');
                onUnlinked();
            } catch {
                // A mount with no reachable transport at all, or a refused
                // dispatch. The row says so instead of pretending the link is
                // gone.
                setPhase('failed');
            }
        })();
    }, [entryRef, onUnlinked, sessionId, transport]);

    return (
        <List.Item
            title={rowTitle(row, text)}
            tone={phase === 'failed' ? 'warning' : rowTone(row)}
            busy={row.presentation.kind === 'reading' || phase === 'removing'}
            {...(phase === 'failed'
                ? {
                    detail: text(
                        'plugins.triage.sessionLinks.unlinkFailed',
                        'This link could not be removed.',
                    ),
                }
                : {})}
            accessory={entryRef === null ? undefined : (
                <Button
                    titleKey="plugins.triage.sessionLinks.unlink"
                    title={text('plugins.triage.sessionLinks.unlink', 'Unlink')}
                    variant="secondary"
                    disabled={phase === 'removing'}
                    onPress={unlink}
                />
            )}
        />
    );
}

function TriageSessionLinkedEntriesPanel(
    props: Readonly<{ sessionId: string }>,
): React.ReactElement {
    const text = usePluginTranslation();
    const { view, refresh, loadMore } = useTriageSessionLinkedEntries(props.sessionId);
    const mounted = React.useRef(true);
    const [loadingMore, setLoadingMore] = React.useState(false);
    React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);
    const onRefresh = React.useCallback(() => { void refresh(); }, [refresh]);
    const onLoadMore = React.useCallback(() => {
        if (loadingMore) return;
        setLoadingMore(true);
        void loadMore()
            // The Data pager publishes its typed retained-row error snapshot.
            // A transport implementation that also rejects must not become an
            // unhandled UI promise; the same visible retry remains available.
            .catch(() => undefined)
            .finally(() => {
                if (mounted.current) setLoadingMore(false);
            });
    }, [loadMore, loadingMore]);
    const renderRow = React.useCallback(
        (row: TriageSessionLinkedEntryRowV1): React.ReactElement => (
            <LinkedEntryRow row={row} sessionId={props.sessionId} onUnlinked={onRefresh} />
        ),
        [onRefresh, props.sessionId],
    );

    if (view.kind === 'loading') {
        return (
            <Screen safeArea>
                <LoadingState
                    title={text(
                        'plugins.triage.sessionLinks.loading',
                        `Reading linked ${TRIAGE_DISPLAY_NAME}`,
                    )}
                />
            </Screen>
        );
    }

    if (view.kind === 'unavailable') {
        return (
            <Screen safeArea>
                <ErrorState
                    title={text(
                        'plugins.triage.sessionLinks.unavailable',
                        'Linked entries could not be read',
                    )}
                    description={view.message}
                    action={(
                        <Button
                            title={text('plugins.triage.surface.refresh', 'Refresh')}
                            variant="secondary"
                            onPress={onRefresh}
                        />
                    )}
                />
            </Screen>
        );
    }

    if (view.kind === 'empty') {
        return (
            <Screen safeArea>
                <EmptyState
                    title={text('plugins.triage.sessionLinks.empty.title', 'Nothing is linked yet')}
                    description={text(
                        'plugins.triage.sessionLinks.empty.description',
                        'Start a session from a pull request or issue and it appears here.',
                    )}
                />
            </Screen>
        );
    }

    return (
        <Screen safeArea>
            <Stack gap="small">
                {/*
                  Links are durable Account state, so they stay readable whenever
                  the Account server is reachable — with or without a daemon. What
                  can go missing is the entry's current provider facts, and a row
                  says so instead of disappearing.
                */}
                {view.notice === null ? null : (
                    <Banner
                        tone="warning"
                        title={text(
                            'plugins.triage.sessionLinks.stale.title',
                            'These may not be current',
                        )}
                        description={view.notice}
                        action={(
                            <Button
                                title={text('plugins.triage.surface.refresh', 'Refresh')}
                                variant="secondary"
                                onPress={onRefresh}
                            />
                        )}
                    />
                )}

                {view.more ? (
                    <Banner
                        tone={view.notice === null ? 'info' : 'warning'}
                        title={text(
                            view.notice === null
                                ? 'plugins.triage.sessionLinks.more.title'
                                : 'plugins.triage.surface.moreEntries.failed.title',
                            view.notice === null
                                ? 'More entries are linked'
                                : 'More entries could not be loaded',
                        )}
                        description={text(
                            view.notice === null
                                ? 'plugins.triage.sessionLinks.more.description'
                                : 'plugins.triage.surface.moreEntries.failed.description',
                            view.notice === null
                                ? 'Recent links from this page are shown; the rest are still linked.'
                                : 'The entries already in this list are still here. Try again to reach the rest.',
                        )}
                        action={(
                            <Button
                                title={text(
                                    view.notice === null
                                        ? 'plugins.triage.surface.loadMore'
                                        : 'plugins.triage.surface.loadMore.retry',
                                    view.notice === null ? 'Load more' : 'Try again',
                                )}
                                variant="secondary"
                                busy={loadingMore}
                                disabled={loadingMore}
                                onPress={onLoadMore}
                            />
                        )}
                    />
                ) : null}

                <List<TriageSessionLinkedEntryRowV1>
                    accessibilityLabel={text(
                        'plugins.triage.sessionLinks.label',
                        'Linked {name}',
                        { name: TRIAGE_DISPLAY_NAME },
                    )}
                    density="compact"
                    items={view.rows}
                    keyForItem={(row) => row.key}
                    renderItem={renderRow}
                />
            </Stack>
        </Screen>
    );
}

export function TriageSessionLinkedEntries(_context: RenderContext): React.ReactElement {
    const text = usePluginTranslation();
    const target = useSurfaceContext().target;

    // The one thing this surface refuses is a mount it cannot address. It does
    // not fall back to another Session, and it opens no query at all here.
    if (target.kind !== 'session') {
        return (
            <Screen safeArea>
                <ErrorState
                    title={text(
                        'plugins.triage.sessionLinks.noSession.title',
                        'No session for this panel',
                    )}
                    description={text(
                        'plugins.triage.sessionLinks.noSession.description',
                        `This panel shows the ${TRIAGE_DISPLAY_NAME} linked to one session.`,
                    )}
                />
            </Screen>
        );
    }

    return <TriageSessionLinkedEntriesPanel sessionId={target.sessionId} />;
}

/**
 * The artifact entry the declared `session-linked-entries` renderer mounts. It
 * adds no mount seam of its own: theme, locale, text scale, accessibility and
 * safe-area all arrive through the provider `defineUiSurface` installs.
 */
export const renderSurface: RenderSurface = defineUiSurface(TriageSessionLinkedEntries);
