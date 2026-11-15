import * as React from 'react';
import { readPluginErrorRequestIdV1 } from '@happier-dev/plugin-sdk';
import type { SurfaceContext, RenderContext, RenderSurface } from '@happier-dev/plugin-sdk/ui';
import {
    Avatar,
    Button,
    EmptyState,
    ErrorState,
    FreshnessLine,
    Icon,
    List,
    LoadingState,
    Metadata,
    PaneHeaderContent,
    Popover,
    Row,
    Screen,
    Stack,
    Status,
    Text,
    defineUiSurface,
    projectPluginActionRejectionV1,
    usePluginHostApi,
    usePluginTheme,
    usePluginTranslation,
    useSurfaceContext,
    type IconName,
    type ListSectionData,
    type PluginActionExecution,
    type TextTone,
} from '@happier-dev/plugin-ui';

import { TRIAGE_DISPLAY_NAME } from '../../displayName.js';
import type { TriageSessionLinkedEntriesNoticeV1, TriageSessionLinkedEntryRowV1, TriageSessionLinkedEntrySummaryV1 } from './linkedEntryRows.js';
import { projectTriageUnavailableLinkSources, type TriageUnavailableLinkSourceV1 } from './linkedEntrySourceHealth.js';
import type { TriageSessionLinkedEntryCandidateV1 } from './linkedEntrySearch.js';
import { linkTriageSessionEntry, useTriageSessionLinkCandidates } from './useSessionLinkCandidates.js';
import { formatTriageCompactAgeV1 } from '@happier-dev/triage-protocol/v1';
import { readTriageEntryGlyphV1 } from '../../ui/window/entryDisplay.js';
import { triageEntryRowKey } from '../../projection/listWindow.js';
import { TRIAGE_ENTRY_DETAIL_DESTINATION_V1 } from '../../composer/openEntryDetails.js';
import { useTriageUnlinkLinkedEntry } from './useUnlinkLinkedEntry.js';
import { useTriageSessionLinkedEntries } from './useSessionLinkedEntries.js';
import { isHostCancellation } from '../../hostCancellation.js';
import { presentTriageMountedUiActionFailure } from '../../ui/mountedActions.js';
import { openTriageLinkedEntry } from '../../ui/navigation/openLinkedEntry.js';
import { resolveTriageSourceWorkflowSubjectV1 } from '../../ui/detail/sourceSurface.js';
import { applyTriageSessionPullRequestStatus } from './linkedEntrySummary.js';
import { useLinkedPullRequestStatus, type LinkedPullRequestStatusRead } from './useLinkedPullRequestStatus.js';
import { PullRequestStatusFacts } from '../pullRequestGlance/PullRequestGlance.js';
import { PullRequestFailureDetails } from '../pullRequestGlance/PullRequestReadFailure.js';

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

/*
 * Plugin tabs round 2 (lab `plugin-tabs` P1 / PJ / PP / PA / PE / ST).
 *
 * The linked PRs and issues of this Session, grouped as Pull requests and Issues, each row showing the item's
 * own words once PRs & Issues knows it (the join: title, state, comments, author, age) and its path until then.
 * Pressing a row opens it in place: calm facts, then Open (the primary; "Fix in this session" waits for a host
 * seam), Open at source and Unlink through the shared Action policy. The header "+" links another through
 * `sessions/link-entry-v1`. Expanded PR status is read through the optional source-owned detail role;
 * scan/get, the retained window, and durable Session links remain their existing owners' concerns.
 */

type LinkedRow = TriageSessionLinkedEntryRowV1;
type LinkedEntry = TriageSessionLinkedEntrySummaryV1;
type Translate = ReturnType<typeof usePluginTranslation>;

function entryOf(row: LinkedRow): LinkedEntry | null {
    return row.presentation.kind === 'linked' ? row.presentation.entry : null;
}

function rowKind(row: LinkedRow, sources: SurfaceContext['targetedContributions']): 'pullRequest' | 'issue' | 'other' {
    const entry = entryOf(row);
    if (entry !== null) return entry.kind === 'pullRequest' || entry.kind === 'issue' ? entry.kind : 'other';
    if (row.presentation.kind !== 'linked') return 'other';
    const subject = resolveTriageSourceWorkflowSubjectV1(sources, row.presentation.entryRef);
    return subject === 'pullRequest' || subject === 'issue' ? subject : 'other';
}

function rowTitle(row: LinkedRow, text: Translate): string {
    switch (row.presentation.kind) {
        case 'linked':
            return row.presentation.entry?.title ?? row.presentation.displayPath;
        case 'reading':
            return text('plugins.triage.sessionLinks.reading', 'Reading this link…');
        case 'unlinked':
            return text('plugins.triage.sessionLinks.removed', 'This link was removed.');
        default:
            return text('plugins.triage.sessionLinks.unreadable', 'This link could not be read.');
    }
}

/** The one glyph an entry wears (the PRs & Issues row owner), coloured by where its lifecycle is. */
function entryMark(row: LinkedRow, sources: SurfaceContext['targetedContributions']): Readonly<{ name: IconName; tone: TextTone }> {
    const entry = entryOf(row);
    const subject = entry?.kind ?? (row.presentation.kind === 'linked'
        ? resolveTriageSourceWorkflowSubjectV1(sources, row.presentation.entryRef) : null);
    if (entry === null) return { name: readTriageEntryGlyphV1('active', subject), tone: 'secondary' };
    switch (entry.lifecycle) {
        case 'open':
            return { name: readTriageEntryGlyphV1('active', subject), tone: 'success' };
        case 'draft':
            return { name: readTriageEntryGlyphV1('active', subject), tone: 'secondary' };
        case 'merged':
        case 'done':
            return { name: readTriageEntryGlyphV1('resolved', subject), tone: 'accent' };
        case 'closed':
            return { name: readTriageEntryGlyphV1('closed', subject), tone: 'danger' };
        case 'notPlanned':
            return { name: readTriageEntryGlyphV1('closed', subject), tone: 'muted' };
        case 'suppressed':
            return { name: readTriageEntryGlyphV1('suppressed', subject), tone: 'muted' };
        default:
            return { name: readTriageEntryGlyphV1('active', subject), tone: 'secondary' };
    }
}

function lifecycleTone(entry: LinkedEntry): TextTone {
    switch (entry.lifecycle) {
        case 'open': return 'success';
        case 'merged':
        case 'done': return 'accent';
        case 'closed': return 'danger';
        default: return 'secondary';
    }
}

function whereLabel(entry: LinkedEntry): string {
    return [entry.number === null ? null : `#${entry.number}`, entry.repository].filter((part) => part !== null).join(' ');
}

/** The one loud fact, only when there is one: a review that asks for changes. */
function loudFact(entry: LinkedEntry | null, text: Translate): Readonly<{ label: string; tone: TextTone; icon: IconName }> | null {
    if (entry?.review?.decision === 'changesRequested') {
        return { label: text('plugins.triage.sessionLinks.changesRequested', 'Changes requested'), tone: 'warning', icon: 'warning' };
    }
    if (entry?.review?.decision === 'approved' && entry.lifecycle === 'open') {
        return { label: text('plugins.triage.sessionLinks.approved', 'Approved'), tone: 'success', icon: 'check' };
    }
    return null;
}

function useAge(atMs: number | null): string | null {
    const { locale } = useSurfaceContext();
    return atMs === null ? null : formatTriageCompactAgeV1(locale, atMs, Date.now());
}

/** The row's second line: where it lives, its state word, its comments. */
function LinkedRowFacts(props: Readonly<{ row: LinkedRow }>): React.ReactElement | null {
    const text = usePluginTranslation();
    const { targetedContributions } = useSurfaceContext();
    const entry = entryOf(props.row);
    const linkedAge = useAge(props.row.linkedAtMs > 0 ? props.row.linkedAtMs : null);
    const loud = loudFact(entry, text);
    if (props.row.presentation.kind !== 'linked') return null;
    if (entry === null) {
        const kind = rowKind(props.row, targetedContributions);
        const noun = kind === 'pullRequest'
            ? text('plugins.triage.sessionLinks.kind.pullRequest', 'Pull request')
            : kind === 'issue'
                ? text('plugins.triage.sessionLinks.kind.issue', 'Issue')
                : text('plugins.triage.sessionLinks.kind.entry', 'Entry');
        return (
            <Text
                variant="micro"
                tone="secondary"
                numberOfLines={1}
                value={linkedAge === null ? noun : text('plugins.triage.sessionLinks.linkedAge', '{kind} · linked {age}', { kind: noun, age: linkedAge })}
            />
        );
    }
    return (
        <Stack gap="xsmall">
            <Row gap="xsmall" align="center">
                <Text variant="micro" tone="secondary" numberOfLines={1} value={whereLabel(entry)} />
                {entry.checks === null || entry.checks.total === 0 ? null : <>
                    <Text variant="micro" tone="muted" value="·" />
                    <Icon name={entry.checks.failed > 0 ? 'warning' : entry.checks.passed === entry.checks.total ? 'check' : 'warning'} size="small"
                        tone={entry.checks.failed > 0 ? 'danger' : entry.checks.passed === entry.checks.total ? 'success' : 'warning'} />
                    <Text variant="micro" tone="secondary" value={`${entry.checks.passed}/${entry.checks.total}`} />
                </>}
                {entry.stateLabel === '' || entry.lifecycle === 'open' ? null : (
                    <>
                        <Text variant="micro" tone="muted" value="·" />
                        <Text variant="micro" tone={lifecycleTone(entry)} value={entry.stateLabel === 'Closed as completed' ? text('plugins.triage.sessionLinks.done', 'Done') : entry.stateLabel} />
                    </>
                )}
                {entry.comments === null || entry.comments === 0 ? null : (
                    <>
                        <Text variant="micro" tone="muted" value="·" />
                        <Icon name="conversations" size="small" tone="secondary" />
                        <Text variant="micro" tone="secondary" value={String(entry.comments)} />
                    </>
                )}
            </Row>
            {loud === null ? null : (
                <Row gap="xsmall" align="center">
                    <Icon name={loud.icon} size="small" tone={loud.tone} />
                    <Text variant="micro" tone={loud.tone} value={loud.label} />
                </Row>
            )}
        </Stack>
    );
}

/** Author and age end the row. */
function LinkedRowTrailing(props: Readonly<{ entry: LinkedEntry | null }>): React.ReactElement | null {
    const age = useAge(props.entry?.updatedAtMs ?? null);
    if (props.entry === null) return null;
    return (
        <Row gap="xsmall" align="center">
            {props.entry.author === null ? null : <Avatar name={props.entry.author.name} size="medium" />}
            {age === null ? null : <Text variant="micro" tone="secondary" value={age} />}
        </Row>
    );
}

/**
 * The open row: calm facts, then the row's actions at the bottom. It is offered only on a row that resolved
 * to a link, because that is the only state carrying the entry reference Open and Unlink are addressed by.
 */
function LinkedRowPeek(props: Readonly<{
    row: LinkedRow;
    sessionId: string;
    onRefresh: () => void;
    statusRead: LinkedPullRequestStatusRead;
}>): React.ReactElement | null {
    const { row, sessionId, onRefresh } = props;
    const text = usePluginTranslation();
    const host = usePluginHostApi();
    const title = rowTitle(row, text);
    const { phase, unlink: unlinkRelationship } = useTriageUnlinkLinkedEntry(onRefresh);
    const [opening, setOpening] = React.useState(false);
    const [openFailed, setOpenFailed] = React.useState(false);
    const presentation = row.presentation;
    const entryRef = presentation.kind === 'linked' ? presentation.entryRef : null;
    const sourceInstanceId = presentation.kind === 'linked' ? presentation.sourceInstanceId : undefined;
    const entry = entryOf(row);
    const updated = useAge(entry?.updatedAtMs ?? null);
    const linked = useAge(row.linkedAtMs > 0 ? row.linkedAtMs : null);

    const open = React.useCallback(() => {
        if (entryRef === null || opening) return;
        setOpening(true);
        setOpenFailed(false);
        void openTriageLinkedEntry(host, entryRef).then((result) => {
            setOpening(false);
            setOpenFailed(result.kind === 'refused');
            if (result.kind === 'refused' && result.reason === 'unavailable') return presentTriageMountedUiActionFailure(host, result.error, text);
        });
    }, [entryRef, host, opening, text]);

    const unlink = React.useCallback(() => {
        if (entryRef === null) return;
        void unlinkRelationship({ sessionId, entryRef, sourceInstanceId });
    }, [entryRef, sourceInstanceId, sessionId, unlinkRelationship]);

    if (entryRef === null || presentation.kind !== 'linked') return null;
    const facts = entry === null
        ? [
            { label: text('plugins.triage.sessionLinks.fact.where', 'Where'), value: presentation.displayPath },
            ...(linked === null ? [] : [{ label: text('plugins.triage.sessionLinks.fact.linked', 'Linked'), value: linked }]),
        ]
        : [
            { label: text('plugins.triage.sessionLinks.fact.state', 'State'), value: entry.stateLabel === '' ? text('plugins.triage.sessionLinks.fact.unknown', 'Unknown') : entry.stateLabel },
            ...(entry.author === null ? [] : [{ label: text('plugins.triage.sessionLinks.fact.author', 'Author'), value: entry.author.name }]),
            ...(entry.review === null ? [] : [{
                label: text('plugins.triage.sessionLinks.fact.review', 'Review'),
                value: entry.review.decision === 'approved'
                    ? text('plugins.triage.sessionLinks.approved', 'Approved')
                    : entry.review.decision === 'changesRequested'
                        ? text('plugins.triage.sessionLinks.changesRequested', 'Changes requested')
                        : text('plugins.triage.sessionLinks.reviewRequired', 'Review required'),
                ...(entry.review.decision === 'changesRequested' ? { tone: 'warning' as const } : {}),
            }]),
            ...(entry.comments === null ? [] : [{
                label: text('plugins.triage.sessionLinks.fact.comments', 'Comments'),
                value: String(entry.comments),
            }]),
            { label: text('plugins.triage.sessionLinks.fact.where', 'Where'), value: entry.scopeLabel },
            ...(updated === null ? [] : [{ label: text('plugins.triage.sessionLinks.fact.updated', 'Updated'), value: updated }]),
        ];
    const webUrl = entry?.webUrl ?? null;
    const status = props.statusRead.status;
    const hasDetails = status !== null && (status.checks !== null || status.review !== null || status.merge !== null || status.branch !== null);
    const partial = status !== null && (status.checks === null || status.review === null || status.merge === null || status.branch === null
        || status.checks.incomplete || status.review.incomplete);

    return (
        <Stack gap="medium" testID={`triage-session-link-peek:${row.key}`}>
            {hasDetails && status !== null ? <PullRequestStatusFacts status={status} /> : <Metadata entries={facts} />}
            {props.statusRead.phase === 'reading' ? <FreshnessLine tone="neutral" reason={text('plugins.triage.sessionLinks.status.reading', 'Reading PR status…')} />
                : props.statusRead.phase === 'unavailable' ? <FreshnessLine tone="warning" reason={text('plugins.triage.sessionLinks.status.unavailable', 'PR status is unavailable.')}
                    action={{ label: text('plugins.triage.surface.refresh', 'Refresh'), onPress: onRefresh }} />
                    : partial ? <FreshnessLine tone="neutral" reason={text('plugins.triage.sessionLinks.status.partial', 'Some status details could not be read.')} /> : null}
            {/* A narrow pane wraps the actions to a second line; a label never breaks inside a word ("Op/en"). */}
            <Row gap="small" align="center" wrap>
                <Button
                    variant="primary"
                    title={text('plugins.triage.sessionLinks.open', 'Open')}
                    busy={opening}
                    onPress={open}
                />
                {webUrl === null ? null : (
                    <Button
                        variant="plain"
                        title={text('plugins.triage.surface.detail.openAtSource', 'Open at source')}
                        onPress={() => { void host.openExternalLink(webUrl).catch(error => { if (!isHostCancellation(error, undefined)) return presentTriageMountedUiActionFailure(host, error, text); }); }}
                    />
                )}
                <Stack grow />
                <Button
                    variant="plain"
                    title={text('plugins.triage.sessionLinks.unlink', 'Unlink')}
                    accessibilityLabel={text('plugins.triage.sessionLinks.unlinkNamed', 'Unlink {name}', { name: title })}
                    busy={phase === 'removing'}
                    disabled={phase === 'removing'}
                    onPress={unlink}
                />
            </Row>
            {openFailed ? (
                <Status tone="warning" label={text('plugins.triage.picker.openFailed', 'This entry could not be opened.')} />
            ) : null}
            {phase === 'failed' ? (
                <Status tone="warning" label={text('plugins.triage.sessionLinks.unlinkFailed', 'This link could not be removed.')} />
            ) : null}
        </Stack>
    );
}

function LinkedEntryRow(props: Readonly<{
    row: LinkedRow;
    sessionId: string;
    expanded: boolean;
    onToggle: (key: string) => void;
    onRefresh: () => void;
    refreshRevision: number;
}>): React.ReactElement {
    const baseEntry = entryOf(props.row);
    const statusRead = useLinkedPullRequestStatus(baseEntry, props.expanded, props.refreshRevision);
    const entry = React.useMemo(() => baseEntry === null || statusRead.status === null ? baseEntry
        : applyTriageSessionPullRequestStatus(baseEntry, statusRead.status), [baseEntry, statusRead.status]);
    const row = React.useMemo(() => props.row.presentation.kind !== 'linked' || entry === baseEntry ? props.row
        : { ...props.row, presentation: { ...props.row.presentation, entry } }, [baseEntry, entry, props.row]);
    const text = usePluginTranslation();
    const { targetedContributions } = useSurfaceContext();
    const mark = entryMark(row, targetedContributions);
    const title = rowTitle(row, text);
    const linked = row.presentation.kind === 'linked';
    return (
        <List.Item
            testID={`triage-session-link:${row.key}`}
            title={title}
            titleNumberOfLines={1}
            accessibilityLabel={title}
            {...(entry === null ? {} : { accessibilityHint: [whereLabel(entry), entry.stateLabel].filter(Boolean).join(', ') })}
            tone={row.presentation.kind === 'unreadable' ? 'warning' : row.presentation.kind === 'linked' ? 'neutral' : 'muted'}
            busy={row.presentation.kind === 'reading'}
            icon={<Icon name={mark.name} size="small" tone={mark.tone} />}
            {...(linked ? {
                onPress: () => { props.onToggle(row.key); },
                expanded: props.expanded,
                expandedContent: <LinkedRowPeek row={row} sessionId={props.sessionId} onRefresh={props.onRefresh} statusRead={statusRead} />,
            } : {})}
            accessory={row.presentation.kind === 'unreadable' ? (
                <Button
                    title={text('plugins.triage.surface.refresh', 'Refresh')}
                    variant="secondary"
                    onPress={props.onRefresh}
                />
            ) : <LinkedRowTrailing entry={entry} />}
            accessoryOutsidePressable={row.presentation.kind === 'unreadable'}
        >
            <LinkedRowFacts row={row} />
        </List.Item>
    );
}

/** "{source}: {reason}": the connection's own name, then why it could not be read. */
function sourceProblemText(text: Translate, source: TriageUnavailableLinkSourceV1): string {
    return text('plugins.triage.sessionLinks.sourceProblem', '{source}: {reason}', {
        source: source.label,
        reason: text(source.reason.key, source.reason.fallback),
    });
}

/**
 * The sources a Session's links could not be read from, each named with why, as the quiet line over rows that
 * are still shown (never an empty state). One Refresh serves them all, so it sits on the first line only.
 */
function UnavailableLinkSources(props: Readonly<{
    notice: TriageSessionLinkedEntriesNoticeV1;
    onRefresh: () => void;
}>): React.ReactElement {
    const text = usePluginTranslation();
    const refresh = { label: text('plugins.triage.surface.refresh', 'Refresh'), onPress: props.onRefresh };
    const reasons = props.notice.sources.length === 0
        ? [text('plugins.triage.sessionLinks.unavailable', 'Linked entries could not be read')]
        : props.notice.sources.map((source) => sourceProblemText(text, source));
    return (
        <Stack gap="xsmall">
            {reasons.map((reason, index) => (
                <Stack key={`${reason}\u0000${props.notice.sources[index]?.diagnostic?.code ?? ''}\u0000${props.notice.sources[index]?.diagnostic?.requestId ?? ''}`} gap="xsmall">
                    <FreshnessLine tone="warning" reason={reason} {...(index === 0 ? { action: refresh } : {})} />
                    <PullRequestFailureDetails codes={[props.notice.sources[index]?.diagnostic?.code]}
                        title={`${text('plugins.triage.surface.detail.tab.details', 'Details')}: ${props.notice.sources[index]?.label ?? ''}`}
                        requestId={props.notice.sources[index]?.diagnostic?.requestId} />
                </Stack>
            ))}
            <LinkReadFailureDetails notice={props.notice} />
        </Stack>
    );
}

function LinkReadFailureDetails({ notice }: Readonly<{ notice: TriageSessionLinkedEntriesNoticeV1 }>): React.ReactElement | null {
    const error = notice.error;
    const requestId = readPluginErrorRequestIdV1(error);
    return <PullRequestFailureDetails codes={[error?.code, ...(error?.diagnostics ?? [])]} requestId={requestId} />;
}

/**
 * Search PRs & Issues and link one to this Session (lab PA). One control, two triggers: the pane header's "+",
 * and the empty state's one primary action (lab PE), which opens the same picker from where it was pressed.
 */
function LinkEntryControl(props: Readonly<{
    sessionId: string;
    onLinked: () => void;
    presentation?: 'header' | 'primary';
}>): React.ReactElement {
    const text = usePluginTranslation();
    const [open, setOpen] = React.useState(false);
    const label = text('plugins.triage.sessionLinks.link', 'Link a PR or issue');
    const onLinked = React.useCallback(() => { setOpen(false); props.onLinked(); }, [props]);
    return (
        <Popover
            testID="triage-session-links-link"
            open={open}
            onOpenChange={setOpen}
            trigger={label}
            // The header's "+" is the glyph alone; the empty state's primary leads its label with it (lab PE).
            triggerIcon="add"
            {...(props.presentation === 'primary' ? { triggerAppearance: 'primary' as const } : {})}
            triggerAccessibilityLabel={label}
            placement="bottom"
        >
            {/* Mounted only while open: the candidate reader runs, and finishes the link pages, for an open picker alone. */}
            {open ? <LinkEntryPicker sessionId={props.sessionId} label={label} onLinked={onLinked} /> : null}
        </Popover>
    );
}

/**
 * The open picker: the public List with its own search over the one candidate reader. Every match is listed
 * (the List's virtualization bounds what mounts; nothing is cut at a count), a linked entry wears a check.
 */
export function LinkEntryPicker(props: Readonly<{ sessionId: string; label: string; onLinked: () => void }>): React.ReactElement {
    const text = usePluginTranslation();
    const host = usePluginHostApi();
    const [query, setQuery] = React.useState('');
    const [linking, setLinking] = React.useState<string | null>(null);
    const [failure, setFailure] = React.useState<PluginActionExecution | null>(null);
    const { candidates, status, sourceHealth, refresh } = useTriageSessionLinkCandidates(props.sessionId, query);
    // Healthy rows and search stay; a source that could not be read is named with why, never folded into "no match".
    const unavailable = React.useMemo(() => projectTriageUnavailableLinkSources(sourceHealth), [sourceHealth]);
    const link = React.useCallback((candidate: TriageSessionLinkedEntryCandidateV1) => {
        if (candidate.alreadyLinked || linking !== null) return;
        setLinking(candidateKey(candidate));
        setFailure(null);
        void linkTriageSessionEntry(host, props.sessionId, candidate.entry).then((result) => {
            setLinking(null);
            if (result.status === 'failed') {
                setFailure(projectPluginActionRejectionV1({
                    message: text('plugins.triage.sessionLinks.linkFailed', 'That link didn’t go through. Try again.'),
                }, text));
                return;
            }
            props.onLinked();
        }).catch((error: unknown) => {
            setLinking(null);
            setFailure(projectPluginActionRejectionV1(error, text));
        });
    }, [host, linking, props, text]);
    const renderCandidate = React.useCallback((candidate: TriageSessionLinkedEntryCandidateV1): React.ReactElement => {
        const facts = [whereLabel(candidate.entry), candidate.alreadyLinked ? text('plugins.triage.sessionLinks.alreadyLinked', 'Linked') : null].filter(Boolean);
        return (
            <List.Item
                title={candidate.entry.title}
                titleNumberOfLines={1}
                icon={<Icon name={readTriageEntryGlyphV1(candidate.entry.lifecycle === 'suppressed' ? 'suppressed'
                    : candidate.entry.lifecycle === 'closed' || candidate.entry.lifecycle === 'notPlanned' ? 'closed'
                    : candidate.entry.lifecycle === 'done' || candidate.entry.lifecycle === 'merged' ? 'resolved' : 'active', candidate.entry.kind)}
                    size="small" tone={candidate.entry.lifecycle === 'open' ? 'success' : 'secondary'} />}
                busy={linking === candidateKey(candidate)}
                disabled={candidate.alreadyLinked}
                // A linked entry says so with a mark at the row's end, as in the lab; the words stay beside it.
                accessory={candidate.alreadyLinked ? <Icon name="check" size="small" tone="secondary" /> : undefined}
                accessibilityHint={facts.join(', ')}
                onPress={() => { link(candidate); }}
            >
                <Text variant="micro" tone="secondary" numberOfLines={1} value={facts.join(' · ')} />
            </List.Item>
        );
    }, [link, linking, text]);
    return (
        <List<TriageSessionLinkedEntryCandidateV1>
            testID="triage-session-links-candidates"
            accessibilityLabel={props.label}
            density="compact"
            items={candidates}
            keyForItem={candidateKey}
            renderItem={renderCandidate}
            // The List owns the field; the match is the PRs & Issues search owner's (inside the candidate reader).
            search={{
                label: text('plugins.triage.sessionLinks.search', 'Search PRs & Issues'),
                placeholder: text('plugins.triage.sessionLinks.searchPlaceholder', 'Search by title, number or repository'),
                value: query,
                onValueChange: setQuery,
                filter: keepProjectedCandidate,
            }}
            // Under the search, where it is seen with the first results; a footer would wait at the end of a long list.
            header={unavailable.length === 0 ? null : (
                <UnavailableLinkSources notice={{ sources: unavailable }} onRefresh={() => { void refresh(); }} />
            )}
            empty={status === 'loading' ? (
                <LoadingState rows={3} title={text('plugins.triage.sessionLinks.loading', `Reading linked ${TRIAGE_DISPLAY_NAME}`)} />
            ) : (
                <EmptyState
                    layout="line"
                    title={status === 'unavailable'
                        ? text('plugins.triage.sessionLinks.unavailable', 'Linked entries could not be read')
                        : status === 'partial'
                            ? text('plugins.triage.sessionLinks.searchEmptyPartial', 'Nothing matches in the sources that could be read')
                            : text('plugins.triage.sessionLinks.searchEmpty', 'Nothing matches in PRs & Issues yet')}
                />
            )}
            footer={(
                <Stack gap="xsmall">
                    {failure?.status === 'error' || failure?.status === 'outcomeUnknown' ? (
                        <Stack gap="small">
                            <ErrorState size="pane" title={failure.message} />
                            <PullRequestFailureDetails
                                codes={[failure.code, ...(failure.status === 'error' ? failure.diagnostics?.map(diagnostic => diagnostic.code) ?? [] : [])]}
                                requestId={failure.requestId}
                            />
                        </Stack>
                    ) : null}
                    <Text variant="micro" tone="secondary" value={text('plugins.triage.sessionLinks.linkReassurance', 'Linking doesn’t change anything at the source.')} />
                </Stack>
            )}
        />
    );
}

function candidateKey(candidate: TriageSessionLinkedEntryCandidateV1): string {
    return triageEntryRowKey(candidate.entry.entryRef);
}

/** The candidate reader already matched the query through the PRs & Issues search owner. */
function keepProjectedCandidate(): boolean {
    return true;
}

function buildSections(rows: readonly LinkedRow[], text: Translate, sources: SurfaceContext['targetedContributions']): readonly ListSectionData<LinkedRow>[] {
    const pulls = rows.filter((row) => rowKind(row, sources) === 'pullRequest');
    const issues = rows.filter((row) => rowKind(row, sources) === 'issue');
    const other = rows.filter((row) => rowKind(row, sources) === 'other');
    return [
        { key: 'pulls', title: text('plugins.triage.sessionLinks.group.pullRequests', 'Pull requests'), count: pulls.length, data: pulls },
        { key: 'issues', title: text('plugins.triage.sessionLinks.group.issues', 'Issues'), count: issues.length, data: issues },
        { key: 'other', title: text('plugins.triage.sessionLinks.group.other', 'Other links'), count: other.length, data: other },
    ].filter((section) => section.data.length > 0);
}

function TriageSessionLinkedEntriesPanel(
    props: Readonly<{ sessionId: string }>,
): React.ReactElement {
    const text = usePluginTranslation();
    const host = usePluginHostApi();
    const { spacing } = usePluginTheme();
    const { view, refresh, loadMore } = useTriageSessionLinkedEntries(props.sessionId);
    const { targetedContributions } = useSurfaceContext();
    const mounted = React.useRef(true);
    const [loadingMore, setLoadingMore] = React.useState(false);
    const [expandedKey, setExpandedKey] = React.useState<string | null>(null);
    const [refreshRevision, setRefreshRevision] = React.useState(0);
    React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);
    const onRefresh = React.useCallback(() => { setRefreshRevision((revision) => revision + 1); void refresh(); }, [refresh]);
    const onToggle = React.useCallback((key: string) => {
        setExpandedKey((current) => (current === key ? null : key));
    }, []);
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
    const rows = view.kind === 'linked' ? view.rows : NO_ROWS;
    const sections = React.useMemo(() => buildSections(rows, text, targetedContributions), [rows, text, targetedContributions]);
    const needsYou = rows.filter((row) => entryOf(row)?.review?.decision === 'changesRequested').length;
    const headerActions = React.useMemo(
        () => <LinkEntryControl sessionId={props.sessionId} onLinked={onRefresh} />,
        [onRefresh, props.sessionId],
    );
    const header = (
        <PaneHeaderContent
            line={needsYou > 0 ? [{ text: text('plugins.triage.sessionLinks.needsYouCount', '{count} needs you', { count: needsYou }), attention: true }] : []}
            actions={headerActions}
        />
    );
    const renderRow = React.useCallback(
        (row: LinkedRow): React.ReactElement => (
            <LinkedEntryRow
                row={row}
                sessionId={props.sessionId}
                expanded={expandedKey === row.key}
                onToggle={onToggle}
                onRefresh={onRefresh}
                refreshRevision={refreshRevision}
            />
        ),
        [expandedKey, onRefresh, onToggle, props.sessionId, refreshRevision],
    );

    if (view.kind === 'loading') {
        return (
            <Screen safeArea>
                {header}
                <LoadingState
                    rows={3}
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
                {header}
                <ErrorState
                    kind="unavailable"
                    title={text(
                        'plugins.triage.sessionLinks.unavailable',
                        'Linked entries could not be read',
                    )}
                    {...(view.notice.sources.length === 0 ? {} : {
                        description: view.notice.sources.map((source) => sourceProblemText(text, source)).join('\n'),
                    })}
                    action={(
                        <Button
                            title={text('plugins.triage.surface.refresh', 'Refresh')}
                            variant="secondary"
                            onPress={onRefresh}
                        />
                    )}
                />
                {view.notice.sources.map((source, index) => <PullRequestFailureDetails key={index}
                    title={`${text('plugins.triage.surface.detail.tab.details', 'Details')}: ${source.label}`}
                    codes={[source.diagnostic?.code]} requestId={source.diagnostic?.requestId} />)}
                <LinkReadFailureDetails notice={view.notice} />
            </Screen>
        );
    }

    if (view.kind === 'empty') {
        return (
            <Screen safeArea>
                {header}
                <EmptyState
                    icon="change-open"
                    title={text('plugins.triage.sessionLinks.empty.inviteTitle', 'Keep this session’s PRs and issues at hand')}
                    description={text(
                        'plugins.triage.sessionLinks.empty.inviteDescription',
                        'Link a pull request or issue, or start a session from one. It stays here with its state and comments, one tap from the details.',
                    )}
                    action={<LinkEntryControl sessionId={props.sessionId} onLinked={onRefresh} presentation="primary" />}
                    secondaryAction={(
                        <Button
                            variant="plain"
                            title={text('plugins.triage.sessionLinks.browse', 'Browse PRs & Issues')}
                            onPress={() => { void host.openSurface(TRIAGE_ENTRY_DETAIL_DESTINATION_V1).catch(error => { if (!isHostCancellation(error, undefined)) return presentTriageMountedUiActionFailure(host, error, text); }); }}
                        />
                    )}
                />
            </Screen>
        );
    }

    return (
        <Screen safeArea>
            {header}
            <List<LinkedRow>
                accessibilityLabel={text(
                    'plugins.triage.sessionLinks.label',
                    'Linked {name}',
                    { name: TRIAGE_DISPLAY_NAME },
                )}
                density="compact"
                sections={sections}
                keyForItem={(row) => row.key}
                renderItem={renderRow}
                header={view.notice === null ? null : (
                    // Links are durable Account state, so they stay readable whenever the Account server is
                    // reachable — with or without a daemon. What can go missing is the entry's current provider
                    // facts: one freshness line over the retained rows, never a banner.
                    <UnavailableLinkSources notice={view.notice} onRefresh={onRefresh} />
                )}
                footer={view.more ? (
                    <Row gap="small" align="center" style={{ paddingHorizontal: spacing.large, paddingVertical: spacing.small }}>
                        <Text
                            variant="micro"
                            tone={view.notice === null ? 'secondary' : 'warning'}
                            value={view.notice === null
                                ? text('plugins.triage.sessionLinks.more.description', 'Recent links from this page are shown; the rest are still linked.')
                                : text('plugins.triage.surface.moreEntries.failed.title', 'More entries could not be loaded')}
                        />
                        <Button
                            title={text(
                                view.notice === null
                                    ? 'plugins.triage.surface.loadMore'
                                    : 'plugins.triage.surface.loadMore.retry',
                                view.notice === null ? 'Load more' : 'Try again',
                            )}
                            variant="plain"
                            busy={loadingMore}
                            disabled={loadingMore}
                            onPress={onLoadMore}
                        />
                    </Row>
                ) : null}
            />
        </Screen>
    );
}

const NO_ROWS: readonly LinkedRow[] = Object.freeze([]);

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
