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
    usePluginTranslation,
    useSurfaceContext,
} from '@happier-dev/plugin-ui';

import { TRIAGE_DISPLAY_NAME } from '../../displayName.js';
import type { TriageSessionLinkedEntryRowV1 } from './linkedEntryRows.js';
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

function LinkedEntryRow(props: Readonly<{ row: TriageSessionLinkedEntryRowV1 }>): React.ReactElement {
    const { row } = props;
    const text = usePluginTranslation();
    return (
        <List.Item
            title={rowTitle(row, text)}
            tone={rowTone(row)}
            busy={row.presentation.kind === 'reading'}
        />
    );
}

function TriageSessionLinkedEntriesPanel(
    props: Readonly<{ sessionId: string }>,
): React.ReactElement {
    const text = usePluginTranslation();
    const { view, refresh } = useTriageSessionLinkedEntries(props.sessionId);
    const onRefresh = React.useCallback(() => { void refresh(); }, [refresh]);
    const renderRow = React.useCallback(
        (row: TriageSessionLinkedEntryRowV1): React.ReactElement => <LinkedEntryRow row={row} />,
        [],
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
                        tone="info"
                        title={text(
                            'plugins.triage.sessionLinks.more.title',
                            'More entries are linked',
                        )}
                        description={text(
                            'plugins.triage.sessionLinks.more.description',
                            'This panel shows the most recently linked; the rest are still linked.',
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
