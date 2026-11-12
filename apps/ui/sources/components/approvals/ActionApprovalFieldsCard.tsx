import * as React from 'react';
import { View, useWindowDimensions, type TextStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    HappierApprovalFieldEntries,
    HappierApprovalFields,
    HappierPressable,
    type HappierApprovalFieldEntry,
    type HappierApprovalFieldResolve,
    type HappierApprovalFieldRow,
    type HappierApprovalFieldsLook,
    type HappierApprovalFieldsTextRender,
    happierPageTextMetrics,
} from '@happier-dev/plugin-ui/presentation';

import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { DisclosureCaret } from '@/components/ui/lists/DisclosureCaret';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { TechnicalDetailsDisclosure, type TechnicalDetailsLine } from '@/components/ui/lists/TechnicalDetailsDisclosure';
import { readPluginUiHostTypography } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { Text } from '@/components/ui/text/Text';
import { InlineCode } from '@/components/ui/text/InlineCode';
import { resolveViewportClass } from '@/utils/platform/viewportClass';
import { Typography } from '@/constants/Typography';
import { getTranslationValue, t, tLoose } from '@/text';
import type { ApprovalActionFieldsPresentation } from './approvalFieldValues';
import { presentPluginInstallApprovalRows } from './pluginInstallApprovalFacts';
import { useApprovalReferenceReading, type ApprovalReferenceReading } from './approvalReferenceReading';
import { navigateToSession } from '@/hooks/session/useNavigateToSession';
import { useDestinationRouter } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useOptionalAuth } from '@/auth/context/AuthContext';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { MachineGuardCeilingApprovalFields } from './MachineGuardCeilingApprovalFields';
import { DiscussionReplyApprovalFields } from './DiscussionReplyApprovalFields';
import { isDiscussionReplyActionIdV1 } from '@happier-dev/protocol/discussions';

/** Presentation needs the carried review, not an Artifact or an approval decision record. */
export type ApprovalFieldsRequest = Pick<ApprovalRequest, 'actionId' | 'actionArgs' | 'preview'> & Partial<Pick<ApprovalRequest, 'status'>>;

const EXACT_READ = { exactRead: true } as const;
/** The page's label column: wide enough for a short phrase ("Before it starts"), so every value shares one edge. */
const PAGE_FIELD_LABEL_WIDTH_PX = 128;

/**
 * What a domain review adds to one of its facts on the approval page (lab d3 review): the names it lists, each
 * drawn as a chip, and a quieter line under the value that finishes the thought. A card folds both into its value.
 */
export type ApprovalFieldExtras = Readonly<{ names?: readonly string[]; note?: string }>;
type ApprovalFieldRow = ApprovalActionFieldsPresentation['rows'][number] & ApprovalFieldExtras;
/** A request's arguments as the protocol reads them, or a domain review's facts with their extras. */
export type ApprovalFieldsPresentation = Readonly<{
    rows: readonly ApprovalFieldRow[];
    unrepresentable: ApprovalActionFieldsPresentation['unrepresentable'];
}>;
type ApprovalValueRow = Extract<ApprovalFieldRow, { kind: 'value' }>;
type ApprovalReference = NonNullable<ApprovalValueRow['reference']>;
type ApprovalStructuredEntries = NonNullable<ApprovalValueRow['entries']>;
/** What core reads to name a value: the reference, the approval's Home, and whether the page settles it by one exact read. */
type ApprovalValueSource = Readonly<{ reference: ApprovalReference; serverId: string | null; exactRead: boolean }>;

/**
 * Core's binding of the shared approval fields (`HappierApprovalFields`, plugin-ui): the arguments an approval
 * would run with. `card` (default) is the self-contained table a transcript prompt shows; `page` is the approval
 * page's "Details" section, in the page's own section and row anatomy (one row per argument: its name, then its
 * value). Core reads its references by name here; the anatomy is the shared owner's.
 */
export const ActionApprovalFieldsCard = React.memo(function ActionApprovalFieldsCard(props: Readonly<{
    presentation: ApprovalFieldsPresentation;
    /** The original request supplies identity for domain-owned live review facts. */
    request?: ApprovalFieldsRequest;
    anatomy?: 'card' | 'page';
    /** The approval's Home: a value that is one of its sessions (or a Home) reads by its name. */
    serverId?: string | null;
    /** The exact identity of a Home this device cannot name; its own line never says it, so it waits here. */
    homeIdentity?: string;
    /** A failure's code the page keeps behind this same disclosure, after the arguments' own lines. */
    failureCode?: string;
    /** The executor's own words for that failure, kept in the same disclosure ahead of its code. */
    failureMessage?: string;
    /** Typed failure facts from the shared presenter, alongside the arguments' technical lines. */
    failureTechnicalDetails?: readonly ApprovalTechnicalLine[];
    /** The call's raw output, kept in the same disclosure when its row defers to this card (a declined request). */
    outputText?: string;
    /** Card only: the arguments start behind their "Details" line (a phone's inline prompt keeps its decision in view). */
    collapsed?: boolean;
    /**
     * A page opened on its own (a tool call's details) mounts no Session list, so a Session argument
     * settles by one exact read instead of waiting on a list that never loads.
     */
    exactSessionReads?: boolean;
    /** Page only: the section's title when these fields are not the request's arguments (a call's Result). */
    title?: string;
    /** Page only: the sentence above the rows when the title alone does not say what they mean. */
    description?: string;
    testID?: string;
}>) {
    const [detailsOpen, setDetailsOpen] = React.useState(props.collapsed !== true);
    const reading = { ...props, detailsOpen, setDetailsOpen };
    if (props.request && isDiscussionReplyActionIdV1(props.request.actionId) && (props.anatomy === 'page' || detailsOpen)) return (
        <DiscussionReplyApprovalFields request={props.request} serverId={props.serverId ?? null}>
            {presentation => <ApprovalFieldsReading {...reading} presentation={presentation} />}
        </DiscussionReplyApprovalFields>
    );
    if (props.request?.actionId === 'machines.guard.sessionCeiling.set' && (props.anatomy === 'page' || detailsOpen)) return (
        <MachineGuardCeilingApprovalFields request={props.request} serverId={props.serverId ?? null}>
            {presentation => <ApprovalFieldsReading {...reading} presentation={presentation} />}
        </MachineGuardCeilingApprovalFields>
    );
    return <ApprovalFieldsReading {...reading} />;
});

const ApprovalFieldsReading = React.memo(function ApprovalFieldsReading(props: React.ComponentProps<typeof ActionApprovalFieldsCard> & Readonly<{
    detailsOpen: boolean;
    setDetailsOpen: React.Dispatch<React.SetStateAction<boolean>>;
}>) {
    const { detailsOpen, setDetailsOpen } = props;
    const look = useApprovalFieldsLook();
    // A kind with its own human presentation reads through it; its raw structure stays in Technical details.
    const allRows = React.useMemo((): readonly ApprovalFieldRow[] => presentPluginInstallApprovalRows(props.presentation.rows), [props.presentation.rows]);
    // People read names, choices and values; opaque ids stay present, one disclosure away.
    const rows = React.useMemo(() => allRows.filter((row) => !(row.kind === 'value' && row.technical)), [allRows]);
    const technical = React.useMemo(
        () => [...collectApprovalTechnicalLines(allRows),
            ...(props.failureTechnicalDetails ?? [
                ...(props.failureMessage ? [{ key: 'failure-message', label: t('detailPages.approval.failureTitle'), value: props.failureMessage }] : []),
                ...(props.failureCode ? [{ key: 'failure-code', label: t('common.error'), value: props.failureCode }] : []),
            ]),
            ...(props.outputText ? [{ key: 'tool-output', label: t('toolView.output'), value: props.outputText }] : []),
            ...(props.homeIdentity ? [{ key: 'home-identity', label: t('common.home'), value: props.homeIdentity }] : [])],
        [allRows, props.failureCode, props.failureTechnicalDetails, props.failureMessage, props.homeIdentity, props.outputText],
    );
    const serverId = props.serverId ?? null;
    const exactRead = props.exactSessionReads === true;
    const fieldRows = React.useMemo(() => rows.map(row => toSharedFieldRow(row, serverId, exactRead)), [exactRead, rows, serverId]);
    const cardRows = React.useMemo(() => fieldRows.map((row, index) => foldApprovalFieldExtras(row, rows[index]!)), [fieldRows, rows]);
    // A phone reads each label over its value; anything wider sets the labels in one column beside the values.
    const { width, height } = useWindowDimensions();
    const columns = resolveViewportClass({ width, height }) !== 'compact';
    if (allRows.length === 0 && technical.length === 0) return null;
    const technicalDetails = technical.length > 0 ? <ApprovalTechnicalDetails lines={technical} /> : null;

    if (props.anatomy === 'page') {
        return (
            <ItemGroup title={props.title ?? t('approvals.details')} description={props.description} testID={props.testID}>
                {fieldRows.map((row, index) => row.kind === 'value' ? (
                    <ApprovalValueItem key={row.key} row={row} columns={columns} extras={rows[index]!}
                        testID={props.testID ? `${props.testID}.rows.row:${row.key}` : undefined} />
                ) : row.kind === 'entries' ? (
                    // A structured value is still one argument: the same row as its siblings, the
                    // argument's name as the label and its entries in the value's place.
                    <Item
                        key={row.key}
                        title={<ApprovalFieldLayout label={row.label} columns={columns}>
                            <HappierApprovalFieldEntries {...look} entries={row.entries} density="page" />
                        </ApprovalFieldLayout>}
                        mode="info"
                        showChevron={false}
                    />
                ) : (
                    // Questions and answers, or the notice that a value cannot be shown, are content
                    // rather than one value: they sit in the section under the argument's name.
                    <SectionContentRow key={row.key}>
                        <HappierApprovalFields {...look} anatomy="stack" rows={[row]} />
                    </SectionContentRow>
                ))}
                {technicalDetails}
            </ItemGroup>
        );
    }

    if (props.collapsed) {
        // Inside the prompt card the arguments wait behind one quiet "Details" line, not a second card.
        return (
            <View>
                <ExpandableItem
                    testID="approvals.details-disclosure"
                    expanded={detailsOpen}
                    onExpandedChange={setDetailsOpen}
                    showDivider={false}
                    header={({ headerProps, expanded }) => (
                        <HappierPressable
                            accessibilityRole="button"
                            expanded={expanded}
                            onPress={headerProps.onPress}
                            style={styles.disclosureHeader}
                        >
                            <Text style={styles.disclosureTitle}>{t('approvals.details')}</Text>
                            <DisclosureCaret expanded={expanded} />
                        </HappierPressable>
                    )}
                >
                    <View style={styles.disclosureBody}>
                        <HappierApprovalFields {...look} anatomy="stack" rows={cardRows} footer={technicalDetails} />
                    </View>
                </ExpandableItem>
            </View>
        );
    }
    // An open card reads its arguments as one inset table, label beside value (lab `b-ask C`): the card
    // already says what is asked, so the table carries no heading or border of its own.
    return (
        <HappierApprovalFields {...look} testID="approvals.fields-table" rows={cardRows} footer={technicalDetails} />
    );
});

/** Core's inks, steps, faces and `Text` (font scaling) on the shared fields, and its reference reading. */
export function useApprovalFieldsLook(): HappierApprovalFieldsLook<ApprovalValueSource> & Readonly<{ radius: number }> {
    const { theme } = useUnistyles();
    return React.useMemo(() => ({
        Resolve: ApprovalReferenceResolve,
        colors: {
            text: theme.colors.text.primary,
            secondaryText: theme.colors.text.secondary,
            mutedText: theme.colors.text.tertiary,
            danger: theme.colors.state.danger.foreground,
            inset: theme.colors.surface.inset,
        },
        space: theme.space,
        typography: readPluginUiHostTypography(),
        renderText: renderApprovalFieldText,
        radius: theme.borderRadius.md,
    }), [theme]);
}

const renderApprovalFieldText: HappierApprovalFieldsTextRender = (input) => <Text style={input.style as TextStyle}>{input.text}</Text>;

/**
 * An id the person knows by name (a session, a Home) reads by that name; a session this device cannot name
 * reads by where it lives. Its key names the thing, not its handle.
 */
const ApprovalReferenceResolve: HappierApprovalFieldResolve<ApprovalValueSource> = (props) => {
    const reading = useApprovalReferenceReading(props.source.reference, props.value, props.source.serverId,
        props.source.exactRead ? EXACT_READ : undefined);
    return <>{props.children({ label: reading.label ?? nameApprovalReferenceLabel(props.label, props.source.reference, reading.named), value: reading.text })}</>;
};

/** The protocol's row in the shared fields' words: literal values formatted and localized here, references left to `Resolve`. */
function toSharedFieldRow(row: ApprovalFieldRow, serverId: string | null, exactRead: boolean): HappierApprovalFieldRow<ApprovalValueSource> {
    if (row.kind === 'unrepresentable') {
        return { kind: 'notice', key: row.path, label: row.title, title: t('approvals.unsafeDetailsTitle'),
            body: t('approvals.unsafeDetailsBody'), testID: 'approvals.unrepresentable-details' };
    }
    if (row.kind === 'structuredAnswers') {
        return { kind: 'answers', key: row.path, label: row.title, answers: row.answers.map(answer => ({ question: answer.question, values: answer.values })) };
    }
    if (row.entries) {
        // Structured entries read their references without the page's exact read, as Protocol lays them out.
        return { kind: 'entries', key: row.path, label: row.title, entries: readableApprovalEntries(row.entries).map((entry): HappierApprovalFieldEntry<ApprovalValueSource> => ({
            label: entry.label,
            depth: entry.depth,
            value: entry.value === null ? null : entry.valueFormat === 'timestamp' ? formatApprovalTimestamp(entry.value) : entry.value,
            ...(entry.reference ? { source: { reference: entry.reference, serverId, exactRead: false } } : {}),
        })) };
    }
    return { kind: 'value', key: row.path, label: row.title, value: literalApprovalValue(row),
        ...(row.reference ? { source: { reference: row.reference, serverId, exactRead } } : {}) };
}

/** A card has no chips or second line: its value reads as the names, then the note on the next line. */
function foldApprovalFieldExtras(row: HappierApprovalFieldRow<ApprovalValueSource>, extras: ApprovalFieldExtras): HappierApprovalFieldRow<ApprovalValueSource> {
    if (row.kind !== 'value' || (!extras.names?.length && !extras.note)) return row;
    return { ...row, value: [extras.names?.length ? extras.names.join(', ') : row.value, extras.note].filter(Boolean).join('\n') };
}

/**
 * A declared confidential input is held by the original request and never shown: it reads as supplied under
 * its declared title, not as a missing or unavailable value.
 */
function literalApprovalValue(row: ApprovalValueRow): string {
    return row.valueFormat === 'unavailable' ? t('common.unavailable')
        : row.valueFormat === 'confidential' ? t('approvals.confidentialSupplied')
        : row.valueFormat === 'timestamp' ? formatApprovalTimestamp(row.value)
        : row.valueFormat === 'boolean' ? t(row.value === 'true' ? 'common.yes' : 'common.no')
        : row.selectedOptions ? row.selectedOptions.map(option => option.labelKey && typeof getTranslationValue(option.labelKey) === 'string'
            ? tLoose(option.labelKey) : option.label).join(', ') : row.value;
}

/** One argument on the approval page: a Session the page could read is a way to it. */
function ApprovalValueItem(props: Readonly<{
    row: Extract<HappierApprovalFieldRow<ApprovalValueSource>, { kind: 'value' }>;
    columns: boolean;
    extras: ApprovalFieldExtras;
    testID?: string;
}>) {
    const { row, columns, extras } = props;
    const source = row.source;
    const reading = useApprovalReferenceReading(source?.reference, row.value, source?.serverId ?? null, source?.exactRead ? EXACT_READ : undefined);
    const label = nameApprovalReferenceLabel(row.label, source?.reference, reading.named);
    const title = (
        <ApprovalFieldLayout label={label} columns={columns}>
            <ApprovalFieldValue value={reading.text} names={extras.names} note={extras.note}
                code={extras.kind === 'value' && extras.valueFormat === 'code'} />
        </ApprovalFieldLayout>
    );
    if (reading.session) return <ApprovalSessionLinkItem title={title} session={reading.session} />;
    return <Item title={title} mode="info" showChevron={false} testID={props.testID} />;
}

/**
 * The label stays quiet and the value reads first, at every width. Wide, the labels share one column and the
 * values one edge down the section; a phone sets each label above its value.
 */
function ApprovalFieldLayout(props: Readonly<{ label: string; columns: boolean; children: React.ReactNode }>) {
    return (
        <View style={props.columns ? styles.columns : styles.stacked}>
            <Text style={props.columns ? styles.columnLabel : styles.stackedLabel}>{props.label}</Text>
            <View style={styles.columnValue}>{props.children}</View>
        </View>
    );
}

/** A value, the names it lists as chips, then the quieter line that finishes it. */
function ApprovalFieldValue(props: Readonly<{ value: string; names?: readonly string[]; note?: string; code?: boolean }>) {
    return (
        <View style={styles.value}>
            {props.names?.length ? (
                <View style={styles.names}>
                    {props.names.map(name => <InlineCode key={name}>{name}</InlineCode>)}
                </View>
            ) : <Text style={props.code ? styles.codeValueText : styles.valueText}>{props.value}</Text>}
            {props.note ? <Text style={styles.noteText}>{props.note}</Text> : null}
        </View>
    );
}

/** A Session the page could read is a way to it: its row opens that Session. */
function ApprovalSessionLinkItem(props: Readonly<{ title: React.ReactNode;
    session: NonNullable<ApprovalReferenceReading['session']> }>) {
    // The shared open-a-Session owner (Home switch, telemetry, destination); a page outside a signed-in
    // shell (an isolated render) has no Account to refresh, so the switch only skips that refresh.
    const router = useDestinationRouter();
    const refreshFromActiveServer = useOptionalAuth()?.refreshFromActiveServer;
    const { id, serverId } = props.session;
    return (
        <Item
            testID="approvals.session-link"
            title={props.title}
            onPress={() => void navigateToSession(id, serverId ? { serverId } : undefined,
                { router, refreshFromActiveServer: refreshFromActiveServer ?? (async () => {}) })}
        />
    );
}

/** A Protocol moment (epoch milliseconds) as the app says its other times; an unreadable value stays as sent. */
function formatApprovalTimestamp(value: string): string {
    const at = Number(value);
    return Number.isFinite(at) ? formatAsOfTime(at) : value;
}

/**
 * A key over a name names the thing, not its handle: "Session id" beside a Session's title reads
 * "Session", "Agent target" reads "Agent", "Model selection" reads "Model", a Home's server id reads
 * "Home". The exact value keeps its key in Technical details.
 */
function nameApprovalReferenceLabel(label: string, reference: ApprovalReference | undefined, named: boolean): string {
    const handle = /(\s+(id|key|target|selection))+$/i;
    if (!reference || !named || !handle.test(label)) return label;
    const stem = label.replace(handle, '');
    if (!stem) return label;
    return reference.kind === 'home' && /^server$/i.test(stem) ? t('common.home') : stem;
}

export type ApprovalTechnicalLine = TechnicalDetailsLine;

/**
 * What the readable part leaves out, in the request's order, labelled by where it sits ("Widget surface ›
 * Server id"): the exact id behind each name shown above, schema versions and empty values.
 */
function collectApprovalTechnicalLines(rows: readonly ApprovalFieldRow[]): readonly ApprovalTechnicalLine[] {
    const lines: ApprovalTechnicalLine[] = [];
    for (const row of rows) {
        if (row.kind !== 'value') continue;
        if (row.reference) lines.push({ key: row.path, label: row.title, value: row.value });
        else if (row.technical && !row.entries && row.path !== 'v'
            && !['', '{}', '[]', 'null'].includes(row.value)) lines.push({ key: row.path, label: row.title, value: row.value });
        if (!row.entries) continue;
        const trail: string[] = [];
        row.entries.forEach((entry, index) => {
            trail.length = entry.depth;
            if (entry.value === null) { trail.push(entry.label); return; }
            // Versions and empty values do not identify the effect. Exact ids behind resolved
            // names do, so the disclosure retains only those references.
            if (entry.reference || entry.technical && entry.label !== 'V'
                && !['', '{}', '[]', 'null'].includes(entry.value)) {
                lines.push({ key: `${row.path}:${index}`, label: [row.title, ...trail, entry.label].join(' › '), value: entry.value });
            }
        });
    }
    return lines;
}

/** The readable part of a structured value: technical leaves leave, and so do groups left empty. */
function readableApprovalEntries(entries: ApprovalStructuredEntries): ApprovalStructuredEntries {
    const kept: ApprovalStructuredEntries[number][] = [];
    entries.forEach((entry, index) => {
        if (entry.value !== null) {
            if (!entry.technical) kept.push(entry);
            return;
        }
        // A group stays when any leaf below it (before the next sibling or shallower line) is readable.
        for (let next = index + 1; next < entries.length && entries[next]!.depth > entry.depth; next += 1) {
            const candidate = entries[next]!;
            if (candidate.value !== null && !candidate.technical) { kept.push(entry); return; }
        }
    });
    return kept;
}

/** The approval page's Technical details: the shared disclosure, titled for approvals. */
export function ApprovalTechnicalDetails(props: Readonly<{ lines: readonly ApprovalTechnicalLine[] }>) {
    return (
        <TechnicalDetailsDisclosure
            testID="approvals.technical-details"
            title={t('approvals.technicalDetails')}
            lines={props.lines}
        />
    );
}

const styles = StyleSheet.create((theme) => ({
    disclosureHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: theme.space.s4,
    },
    disclosureTitle: {
        ...Typography.variant('meta', 'semiBold'),
        color: theme.colors.text.secondary,
    },
    disclosureBody: {
        paddingTop: theme.space.s8,
    },
    columns: {
        flexDirection: 'row',
        gap: theme.space.s16,
    },
    // The label sits on the value's first line: the steps differ, so it drops by half their difference.
    columnLabel: {
        ...happierPageTextMetrics('rowDescription'),
        width: PAGE_FIELD_LABEL_WIDTH_PX,
        flexShrink: 0,
        paddingTop: (happierPageTextMetrics('rowTitle').lineHeight - happierPageTextMetrics('rowDescription').lineHeight) / 2,
        color: theme.colors.text.tertiary,
    },
    stacked: {
        gap: theme.space.s4,
    },
    stackedLabel: {
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.tertiary,
    },
    columnValue: {
        flex: 1,
        minWidth: 0,
    },
    value: {
        gap: theme.space.s4,
    },
    valueText: {
        ...happierPageTextMetrics('rowTitle'),
        ...Typography.default(),
        color: theme.colors.text.primary,
    },
    /** A literal compared character by character (a host key fingerprint): the code face at the row's size. */
    codeValueText: {
        ...happierPageTextMetrics('rowTitle'),
        ...Typography.mono(),
        color: theme.colors.text.primary,
    },
    noteText: {
        ...happierPageTextMetrics('rowDescription'),
        ...Typography.default(),
        color: theme.colors.text.secondary,
    },
    names: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: theme.space.s4,
    },
}));

