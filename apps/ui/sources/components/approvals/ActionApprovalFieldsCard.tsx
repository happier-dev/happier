import * as React from 'react';
import { View, useWindowDimensions, type TextStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    HappierApprovalFieldEntries,
    HappierApprovalFields,
    HappierDisclosureToggle,
    type HappierApprovalFieldEntry,
    type HappierApprovalFieldResolve,
    type HappierApprovalFieldRow,
    type HappierApprovalFieldsLook,
    type HappierApprovalFieldsTextRender,
} from '@happier-dev/plugin-ui/presentation';
import { resolvePartialMachineReferenceReviewReaderV1 } from '@happier-dev/protocol/machines/machineReferenceCensusV1';

import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { useCoreDisclosureToggleBinding } from '@/components/ui/lists/DisclosureCaret';
import { FieldLayout, FieldValue } from '@/components/ui/lists/FieldRow';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { TechnicalDetailsDisclosure, type TechnicalDetailsLine } from '@/components/ui/lists/TechnicalDetailsDisclosure';
import { useEnvironmentName } from '@/components/projects/deployments/useEnvironmentName';
import { readPluginUiHostTypography } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { Text } from '@/components/ui/text/Text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { resolveViewportClass } from '@/utils/platform/viewportClass';
import { getTranslationValue, t, tLoose } from '@/text';
import {
    readPluginEventTriggerApprovalEnvironmentId,
    readPluginEventTriggerApprovalSummary,
    readTriggerUpdateApprovalAutomationId,
    presentTriggerUpdateAutomationName,
    type ApprovalActionFieldsPresentation,
} from './approvalFieldValues';
import { presentPluginInstallApprovalRows } from './pluginInstallApprovalFacts';
import { useApprovalReferenceReading, type ApprovalReferenceReading } from './approvalReferenceReading';
import { readActionApprovalSubject } from './actionApprovalPresentation';
import { useAutomation } from '@/sync/store/hooks';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { navigateToSession } from '@/hooks/session/useNavigateToSession';
import { useDestinationRouter } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useOptionalAuth } from '@/auth/context/AuthContext';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { TEAM_POLICY_SET_ACTION_ID_V1 } from '@happier-dev/protocol/teams/actionIdsV1';
import { SessionHistoryAccessV1Schema, TeamPolicySetInputV1Schema, TeamRoleV1Schema } from '@happier-dev/protocol/teams';
import { isSessionAccessActionId, SESSION_SPAWN_NEW_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { HomeAdmissionModeV1Schema, HomeAuthenticationPolicyV1Schema, HomeGovernancePolicyFieldV1Schema, HomeRoleV1Schema, TeamCreationPolicyV1Schema } from '@happier-dev/protocol/home/governance';
import { externalSharingLabel, historyLabel, sessionCreationLabel, teamAdmissionModeLabel } from '@/components/settings/teams/teamPolicyPresentation';
import { teamRoleLabel } from '@/components/settings/teams/teamLabels';
import { HOME_IDENTITY_NETWORK_MODE_LABEL_KEYS, homeAdmissionModeLabel, homeGovernancePolicyFieldLabel, homeRoleLabel, homeStoragePolicyLabel, teamCreationPolicyLabel } from '@/components/settings/home/governance/homeGovernanceLabels';
import { homeServerSettingTitle } from '@/components/settings/home/governance/homeServerSettingLabels';
import { homeSettingTitle } from '@/components/settings/home/governance/homeServerSettingsRows';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getHomeSettingsSnapshot, subscribeHomeSettingsSnapshots } from '@/sync/store/home/governance/homeSettingsSnapshots';
import type { HomeSettingEntryV1 } from '@happier-dev/protocol/home/governance';
import { MachineGuardCeilingApprovalFields } from './MachineGuardCeilingApprovalFields';
import { DiscussionReplyApprovalFields } from './DiscussionReplyApprovalFields';
import { isDiscussionReplyActionIdV1 } from '@happier-dev/protocol/discussions';

/** Presentation needs the carried review, not an Artifact or an approval decision record. */
export type ApprovalFieldsRequest = Pick<ApprovalRequest, 'actionId' | 'actionArgs' | 'preview'> & Partial<Pick<ApprovalRequest, 'status'>>
    & Readonly<{ createdBy?: Readonly<{ sessionId?: string | null }>; executionOriginV1?: Readonly<{ sessionId?: string | null }> }>;

/**
 * The Session that asked is already said where the fields are read (its own transcript, the page's Requested by), so
 * an ordinary same-Session target keeps only its exact id, in Technical details, and the changed value leads. A
 * destructive target stays readable before the person acts.
 */
export function demoteAskingSessionTarget(presentation: ApprovalFieldsPresentation, askingSessionId: string | null | undefined): ApprovalFieldsPresentation {
    if (!askingSessionId) return presentation;
    const isAskingTarget = (row: ApprovalFieldRow) => row.kind === 'value' && !row.technical && row.reference?.kind === 'session'
        && row.reference.id === askingSessionId && row.reference.presentation !== 'destructive_target';
    if (!presentation.rows.some(isAskingTarget)) return presentation;
    return { ...presentation, rows: presentation.rows.map(row => isAskingTarget(row) ? { ...row, technical: true as const } : row) };
}

/**
 * The invocation's own context, the Home it runs on (`serverId`) and the Account it runs as (`accountId`), is already
 * said by the page that asks ("Delete this account?" on this Home), so those rows read as filler ("Invoking Home · This
 * Home", "Your Account · Your account") and keep their exact ids in Technical details (R16-D9). A Home or Account the
 * Action acts on (its operand, e.g. `homeServerId`) always stays visible, even when it is this Home or this Account.
 */
const INVOCATION_CONTEXT_PATHS = new Set(['serverId', 'accountId']);
export function demoteSelfReferences(presentation: ApprovalFieldsPresentation, approvalServerId: string | null | undefined,
    viewer: Readonly<{ serverId: string; accountId: string }> | null): ApprovalFieldsPresentation {
    if (!approvalServerId) return presentation;
    const isSelf = (row: ApprovalFieldRow) => row.kind === 'value' && !row.technical && INVOCATION_CONTEXT_PATHS.has(row.path) && (
        (row.reference?.kind === 'home' && areServerProfileIdentifiersEquivalent(row.reference.id, approvalServerId))
        || (row.reference?.kind === 'account' && viewer !== null && viewer.accountId === row.reference.id
            && areServerProfileIdentifiersEquivalent(viewer.serverId, approvalServerId)));
    if (!presentation.rows.some(isSelf)) return presentation;
    return { ...presentation, rows: presentation.rows.map(row => isSelf(row) ? { ...row, technical: true as const } : row) };
}

/**
 * Two values no person reads are mechanism, not facts to judge: a stored envelope (a contributed Action's declared
 * field pointing at a versioned object, `{"v":1,"repositoryId":…}`) and a server-minted record id with no reference
 * behind it (`Deployment cmx07muhg…`). Both keep their exact text in Technical details, so a review never leads with
 * them (R21-D2). Ordinary structured values and ids a person compares (a client id, a host id) stay in view.
 */
const SERVER_RECORD_ID = /^c[a-z0-9]{24}$/;
function isOpaqueValueRow(row: ApprovalFieldRow): boolean {
    if (row.kind !== 'value' || row.technical || row.reference || row.entries || typeof row.value !== 'string') return false;
    const value = row.value.trim();
    if (value.startsWith('{"v":')) {
        try { return typeof JSON.parse(value) === 'object'; } catch { return false; }
    }
    return /Id$/.test(row.path.split('.').at(-1) ?? '') && SERVER_RECORD_ID.test(value);
}
export function demoteOpaqueValues(presentation: ApprovalFieldsPresentation): ApprovalFieldsPresentation {
    if (!presentation.rows.some(isOpaqueValueRow)) return presentation;
    return { ...presentation, rows: presentation.rows.map(row => isOpaqueValueRow(row) ? { ...row, technical: true as const } : row) };
}

function readAskingSessionId(request: ApprovalFieldsRequest | undefined): string | null {
    return request?.executionOriginV1?.sessionId ?? request?.createdBy?.sessionId ?? null;
}

function readMachineReferenceTechnicalLines(request?: ApprovalFieldsRequest): readonly TechnicalDetailsLine[] {
    if (!request) return [];
    const cause = resolvePartialMachineReferenceReviewReaderV1(request.actionId)?.(request.preview)?.failureCause;
    if (!cause) return [];
    const lines: TechnicalDetailsLine[] = [];
    if (cause.errorCode) lines.push({
        key: 'machine-references-cause-code', label: t('approvals.failureTechnicalLabels.causeCode'), value: cause.errorCode,
    });
    if ('nativeErrorReason' in cause && cause.nativeErrorReason) lines.push({
        key: 'machine-references-reason', label: t('approvals.failureTechnicalLabels.reason'), value: cause.nativeErrorReason,
    });
    return lines;
}

const EXACT_READ = { exactRead: true } as const;

/**
 * What a domain review adds to one of its facts on the approval page (lab d3 review): the names it lists, each
 * drawn as a chip, and a quieter line under the value that finishes the thought. A card folds both into its value.
 */
export type ApprovalFieldExtras = Readonly<{ names?: readonly string[]; note?: string;
    /** A carried consequence sentence around the name resolved by the shared reader; UI only. */
    referenceText?: (name: string) => string;
    /** A name that may still be a raw handle keeps one line; the review keeps its exact value under Technical details. */
    singleLine?: boolean }>;
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
type ApprovalValueSource = Readonly<{ reference: ApprovalReference; serverId: string | null; exactRead: boolean;
    referenceText?: (name: string) => string }>;

/**
 * Core's binding of the shared approval fields (`HappierApprovalFields`, plugin-ui): the arguments an approval
 * would run with. `card` (default) is the self-contained table a transcript prompt shows; `page` is the approval
 * page's "Details" section, in the page's own section and row anatomy (one row per argument: its name, then its
 * value). Core reads its references by name here; the anatomy is the shared owner's.
 */
export const ActionApprovalFieldsCard = React.memo(function ActionApprovalFieldsCard(props: Readonly<{
    presentation: ApprovalFieldsPresentation;
    /** The incumbent name already opened by this native confirmation's Save admission. */
    presetSubject?: Readonly<{ reference: Extract<ApprovalReference, { kind: 'machinePreset' }>; name: string }>;
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
    /** Folded card only: the summary sentence the card already reads; a fact whose value it names is not said again. */
    summary?: string | null;
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
    const askingSessionId = readAskingSessionId(props.request);
    const viewer = useAccountSettingsScope();
    const presentation = React.useMemo(() => demoteOpaqueValues(demoteSelfReferences(demoteAskingSessionTarget(props.presentation,
        askingSessionId), props.serverId, viewer)), [askingSessionId, props.presentation, props.serverId, viewer]);
    const reading = { ...props, presentation, detailsOpen, setDetailsOpen };
    if ((props.anatomy === 'page' || detailsOpen) && props.request && props.serverId) {
        const automationId = readTriggerUpdateApprovalAutomationId(props.request);
        const triggerEnvironmentId = readPluginEventTriggerApprovalEnvironmentId(props.request);
        if (automationId || triggerEnvironmentId) {
            return <WorkflowTriggerApprovalFields {...reading} request={props.request}
                automationId={automationId} environmentId={triggerEnvironmentId} />;
        }
    }
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
    if ((props.request?.status === undefined || props.request.status === 'open')
        && (props.anatomy === 'page' || detailsOpen) && props.serverId
        && presentation.rows.some(row => row.kind === 'value' && row.entries?.some(entry => entry.homeSetting))) {
        return <HomeSettingsApprovalFields {...reading} />;
    }
    return <ApprovalFieldsReading {...reading} />;
});

type ApprovalFieldsReadingProps = React.ComponentProps<typeof ActionApprovalFieldsCard> & Readonly<{
    detailsOpen: boolean;
    setDetailsOpen: React.Dispatch<React.SetStateAction<boolean>>;
    homeSettingsRegistry?: ReadonlyMap<string, HomeSettingEntryV1>;
}>;

function WorkflowTriggerApprovalFields(props: ApprovalFieldsReadingProps & Readonly<{
    request: ApprovalFieldsRequest;
    environmentId: string | null;
    automationId: string | null;
}>) {
    const { name: environmentName } = useEnvironmentName(props.serverId ?? null, props.environmentId);
    const automationName = useAutomation(props.automationId ?? '', { serverId: props.serverId })?.name;
    const presentation = React.useMemo(() => {
        const value = environmentName ? readPluginEventTriggerApprovalSummary(props.request, environmentName) : null;
        const withEnvironment = value ? { ...props.presentation, rows: props.presentation.rows.map(row =>
            row.kind === 'value' && row.path === 'trigger.summary' ? { ...row, value } : row) } : props.presentation;
        return presentTriggerUpdateAutomationName(withEnvironment, automationName);
    }, [automationName, environmentName, props.presentation, props.request]);
    return <ApprovalFieldsReading {...props} presentation={presentation} />;
}

function HomeSettingsApprovalFields(props: ApprovalFieldsReadingProps) {
    const { binding } = useServerCredentialAccountScopeBinding(props.serverId);
    // A fresh settings read can require approval. This card only consumes the
    // registry the viewing Account already loaded through Home Settings.
    const subscribe = React.useCallback((listener: () => void) =>
        binding ? subscribeHomeSettingsSnapshots(binding, listener) : () => {}, [binding]);
    const read = React.useCallback(() => binding ? getHomeSettingsSnapshot(binding)?.settings?.entries ?? null : null, [binding]);
    const entries = React.useSyncExternalStore(subscribe, read, read);
    const registry = React.useMemo(() => entries ? new Map(entries.map(entry => [entry.key, entry])) : undefined, [entries]);
    return <ApprovalFieldsReading {...props} homeSettingsRegistry={registry} />;
}

const ApprovalFieldsReading = React.memo(function ApprovalFieldsReading(props: ApprovalFieldsReadingProps) {
    const { detailsOpen, setDetailsOpen } = props;
    const look = useApprovalFieldsLook();
    const disclosure = useCoreDisclosureToggleBinding();
    // A kind with its own human presentation reads through it; its raw structure stays in Technical details.
    const allRows = React.useMemo((): readonly ApprovalFieldRow[] => presentPluginInstallApprovalRows(props.presentation.rows), [props.presentation.rows]);
    // People read names, choices and values; opaque ids stay present, one disclosure away.
    const rows = React.useMemo(() => allRows.filter((row) => !(row.kind === 'value' && row.technical)), [allRows]);
    const technical = React.useMemo(
        () => [...collectApprovalTechnicalLines(allRows),
            ...readMachineReferenceTechnicalLines(props.request),
            ...(props.failureTechnicalDetails ?? [
                ...(props.failureMessage ? [{ key: 'failure-message', label: t('detailPages.approval.failureTitle'), value: props.failureMessage }] : []),
                ...(props.failureCode ? [{ key: 'failure-code', label: t('common.error'), value: props.failureCode }] : []),
            ]),
            ...(props.outputText ? [{ key: 'tool-output', label: t('toolView.output'), value: props.outputText }] : []),
            ...(props.homeIdentity ? [{ key: 'home-identity', label: t('common.home'), value: props.homeIdentity }] : [])],
        [allRows, props.failureCode, props.failureTechnicalDetails, props.failureMessage, props.homeIdentity, props.outputText, props.request],
    );
    const serverId = props.serverId ?? null;
    const exactRead = props.exactSessionReads === true;
    const actionId = props.request?.actionId;
    const language = usePreferredLanguage();
    const { homeSettingsRegistry } = props;
    const fieldRows = React.useMemo(() => rows.map(row => toSharedFieldRow(row, serverId, exactRead, actionId, homeSettingsRegistry)),
        [actionId, exactRead, homeSettingsRegistry, language, rows, serverId]);
    const cardRows = React.useMemo(() => fieldRows.map((row, index) => foldApprovalFieldExtras(row, rows[index]!)), [fieldRows, rows]);
    // A phone reads each label over its value; anything wider sets the labels in one column beside the values.
    const { width, height } = useWindowDimensions();
    const columns = resolveViewportClass({ width, height }) !== 'compact';
    // The thing the sentence is about reads by the same name it has there; only the folded card compares the two.
    const summary = props.collapsed ? props.summary?.trim() || null : null;
    const subject = summary && props.request ? readActionApprovalSubject(props.request) : undefined;
    const subjectReading = useApprovalReferenceReading(subject, '', serverId, exactRead ? EXACT_READ : undefined);
    const foldedRows = React.useMemo(() => summary ? cardRows.filter((row, index) => !isNamedBySummary(summary, row, rows[index]!,
        subject && subjectReading.named && !subjectReading.resolving ? { reference: subject, name: subjectReading.text } : null)) : cardRows,
    [cardRows, rows, subject, subjectReading.named, subjectReading.resolving, subjectReading.text, summary]);
    if (allRows.length === 0 && technical.length === 0) return null;
    const technicalDetails = technical.length > 0 ? <ApprovalTechnicalDetails lines={technical} /> : null;

    if (props.anatomy === 'page') {
        return (
            // With no readable facts, the Technical details disclosure stands alone: no "Details" heading over nothing.
            <ItemGroup title={fieldRows.length > 0 ? props.title ?? t('approvals.details') : undefined}
                description={fieldRows.length > 0 ? props.description : undefined} testID={props.testID}>
                {fieldRows.map((row, index) => row.kind === 'value' ? (
                    <ApprovalValueItem key={row.key} row={row} columns={columns} extras={rows[index]!}
                        presetSubject={props.presetSubject}
                        testID={props.testID ? `${props.testID}.rows.row:${row.key}` : undefined} />
                ) : row.kind === 'entries' ? (
                    // A structured value is still one argument: the same row as its siblings, the
                    // argument's name as the label and its entries in the value's place.
                    <Item
                        key={row.key}
                        title={<FieldLayout label={row.label} columns={columns}>
                            {/* Its values read in the same role and ink as every other fact here and on the card. */}
                            <HappierApprovalFieldEntries {...look} entries={row.entries} stacked={!columns} />
                        </FieldLayout>}
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
        // Inside the prompt card the first fact (the deciding value) always reads, at every width, so a person sees
        // what they approve before Approve is in reach; the remaining facts wait behind one quiet "Details" line.
        const [firstRow, ...remainingRows] = foldedRows;
        return (
            <View style={styles.foldedFacts}>
                {firstRow ? <HappierApprovalFields {...look} testID="approvals.first-fact" anatomy="stack" rows={[firstRow]} /> : null}
                {/* "Details" names facts: with none left after the first, the codes fold behind Technical details itself. */}
                {remainingRows.length === 0 ? technicalDetails : <ExpandableItem
                    testID="approvals.details-disclosure"
                    expanded={detailsOpen}
                    onExpandedChange={setDetailsOpen}
                    showDivider={false}
                    header={({ headerProps, expanded }) => (
                        // The card's one toggle look: the shared in-place disclosure, labelled "Details" (these are facts).
                        <HappierDisclosureToggle
                            label={t('approvals.details')}
                            open={expanded}
                            onPress={headerProps.onPress}
                            caret={disclosure.renderCaret(expanded)}
                            renderLabel={disclosure.renderLabel}
                            focusColor={disclosure.focusColor}
                        />
                    )}
                >
                    <View style={styles.disclosureBody}>
                        <HappierApprovalFields {...look} anatomy="stack" rows={remainingRows} footer={technicalDetails} />
                    </View>
                </ExpandableItem>}
            </View>
        );
    }
    // An open card reads its arguments as one inset table, label beside value (lab `b-ask C`): the card
    // already says what is asked, so the table carries no heading or border of its own.
    return (
        <HappierApprovalFields {...look} testID="approvals.fields-table" rows={cardRows} footer={technicalDetails} />
    );
});

/**
 * Whether the folded card's sentence already says this fact's value: its literal value, or the name of the subject
 * the sentence is about, standing as its own words in the sentence. Values the sentence does not name stay.
 */
function isNamedBySummary(summary: string, row: HappierApprovalFieldRow<ApprovalValueSource>, source: ApprovalFieldRow,
    subject: Readonly<{ reference: ApprovalReference; name: string }> | null): boolean {
    if (row.kind !== 'value' || source.kind !== 'value') return false;
    const named = row.source
        ? subject !== null && row.source.reference.kind === subject.reference.kind && 'id' in row.source.reference
            && 'id' in subject.reference && row.source.reference.id === subject.reference.id ? subject.name : null
        : row.value;
    const value = named?.trim();
    if (!value) return false;
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(summary);
}

/** Core's inks, steps, faces and `Text` (font scaling) on the shared fields, and its reference reading. */
export function useApprovalFieldsLook(): HappierApprovalFieldsLook<ApprovalValueSource> & Readonly<{ radius: number }> {
    const { theme } = useUnistyles();
    return React.useMemo(() => ({
        Resolve: ApprovalReferenceResolve,
        colors: {
            text: theme.colors.text.primary,
            secondaryText: theme.colors.text.secondary,
            mutedText: theme.colors.text.tertiary,
            danger: theme.colors.state.danger.textForeground,
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
    return <>{props.children({ label: reading.label ?? nameApprovalReferenceLabel(props.label, props.source.reference),
        value: isUnnamedApprovalReference(props.source.reference, reading) ? UNNAMED_REFERENCE_VALUE
            : readableApprovalReferenceText(props.source.reference, reading, props.source.referenceText), named: reading.named })}</>;
};

/** A value slot keeps its place for a reference this device cannot name: an em dash, never a word ("Unavailable"). */
const UNNAMED_REFERENCE_VALUE = '—';

/** The reference was read and has no name here; its exact id stays in Technical details. */
function isUnnamedApprovalReference(reference: ApprovalReference | undefined, reading: ApprovalReferenceReading): boolean {
    return reference !== undefined && reference.kind !== 'setting' && !reading.named && !reading.resolving;
}

/** The existing reader owns naming; an unresolved identity stays in Technical details. */
export function readableApprovalReferenceText(reference: ApprovalReference | undefined, reading: ApprovalReferenceReading,
    format?: (name: string) => string): string {
    const name = reference && reference.kind !== 'setting' && !reading.named
        ? t(reading.resolving ? 'common.loading' : 'common.unavailable') : reading.text;
    return format ? format(name) : name;
}

/** The protocol's row in the shared fields' words: literal values formatted and localized here, references left to `Resolve`. */
function toSharedFieldRow(row: ApprovalFieldRow, serverId: string | null, exactRead: boolean, actionId?: string,
    homeSettingsRegistry?: ReadonlyMap<string, HomeSettingEntryV1>): HappierApprovalFieldRow<ApprovalValueSource> {
    if (row.kind === 'unrepresentable') {
        return { kind: 'notice', key: row.path, label: row.title, title: t('approvals.unsafeDetailsTitle'),
            body: t('approvals.unsafeDetailsBody'), testID: 'approvals.unrepresentable-details' };
    }
    if (row.kind === 'structuredAnswers') {
        return { kind: 'answers', key: row.path, label: row.title, answers: row.answers.map(answer => ({ question: answer.question, values: answer.values })) };
    }
    const governance = actionId !== undefined && (actionId.startsWith('teams.') || actionId.startsWith('home.')
        || actionId.startsWith('machines.presets.') || actionId.startsWith('machines.pools.')
        || isSessionAccessActionId(actionId) || actionId === SESSION_SPAWN_NEW_ACTION_ID_V1);
    if (row.entries) {
        // Structured entries read their references without the page's exact read, as Protocol lays them out.
        return { kind: 'entries', key: row.path, label: row.title, entries: readableApprovalEntries(row.entries).map((entry): HappierApprovalFieldEntry<ApprovalValueSource> => {
            const declaration = entry.homeSetting && homeSettingsRegistry?.get(entry.homeSetting.key);
            return {
                label: declaration ? homeSettingTitle(declaration) : entry.homeSetting ? homeServerSettingTitle(entry.homeSetting.key)
                    : readApprovalFieldLabel(entry.label),
                depth: entry.depth,
                value: entry.homeSetting?.cleared ? t('homeSettings.row.notSet')
                    : entry.value === null ? null
                    : governance && isGovernancePrincipal(entry.reference) ? t('common.unavailable')
                    : literalApprovalValue({ ...entry, value: entry.value }, entry.label),
                ...(entry.reference ? { source: { reference: entry.reference, serverId, exactRead: false } } : {}),
            };
        }) };
    }
    const title = readApprovalFieldLabel(row.title);
    const label = row.path === 'primaryTeamId' ? t('session.access.context') : readHomePolicyLabel(row, actionId) ?? title;
    const value = row.valueFormat === 'clear' ? literalApprovalValue(row, label)
        : governance && isGovernancePrincipal(row.reference)
        ? t('common.unavailable') : readGovernanceChoice(row, actionId) ?? literalApprovalValue(row);
    return { kind: 'value', key: row.path, label, value,
        // An exact literal with no name reads in the code face, as the page's value does.
        ...(row.valueFormat === 'code' ? { format: 'code' as const } : {}),
        ...(row.reference ? { source: { reference: row.reference, serverId, exactRead, referenceText: row.referenceText } } : {}) };
}

function isGovernancePrincipal(reference: ApprovalReference | undefined): boolean {
    return reference?.kind === 'account' || reference?.kind === 'homeAccount'
        || reference?.kind === 'team' || reference?.kind === 'group' || reference?.kind === 'teamMembership';
}

function readHomePolicyLabel(row: ApprovalValueRow, actionId: string | undefined): string | undefined {
    if (!actionId?.startsWith('home.')) return;
    if (row.path === 'identityNetworkPolicy.mode') return homeGovernancePolicyFieldLabel('identityNetworkPolicy');
    if (row.value !== 'null' || row.selectedOptions?.[0]?.labelKey !== 'homeSettings.row.notSet') return;
    const field = HomeGovernancePolicyFieldV1Schema.safeParse(row.path);
    if (field.success) return homeGovernancePolicyFieldLabel(field.data);
}

function readGovernanceChoice(row: ApprovalValueRow, actionId: string | undefined): string | undefined {
    if (actionId === TEAM_POLICY_SET_ACTION_ID_V1) return readTeamPolicyChoice(row);
    if (actionId?.startsWith('teams.')) {
        if (row.path === 'role') {
            const choice = TeamRoleV1Schema.safeParse(row.value);
            if (choice.success) return teamRoleLabel(choice.data);
        }
        if (row.path === 'historyAccess') {
            const choice = SessionHistoryAccessV1Schema.safeParse(row.value);
            if (choice.success) return historyLabel(choice.data);
        }
    }
    if (actionId?.startsWith('home.')) {
        if (row.path === 'identityNetworkPolicy.mode' && Object.hasOwn(HOME_IDENTITY_NETWORK_MODE_LABEL_KEYS, row.value)) {
            const mode = row.value as keyof typeof HOME_IDENTITY_NETWORK_MODE_LABEL_KEYS;
            return t(HOME_IDENTITY_NETWORK_MODE_LABEL_KEYS[mode]);
        }
        if (row.path === 'homeRole') {
            const choice = HomeRoleV1Schema.safeParse(row.value);
            if (choice.success) return homeRoleLabel(choice.data);
        }
        if (row.path === 'teamCreationPolicy') {
            const choice = TeamCreationPolicyV1Schema.safeParse(row.value);
            if (choice.success) return teamCreationPolicyLabel(choice.data);
        }
        if (row.path === 'authenticationPolicy.admission') {
            const choice = HomeAdmissionModeV1Schema.safeParse(row.value);
            if (choice.success) return homeAdmissionModeLabel(choice.data);
        }
        if (row.path === 'authenticationPolicy.storagePolicy') {
            const choice = HomeAuthenticationPolicyV1Schema.shape.storagePolicy.safeParse(row.value);
            if (choice.success && choice.data !== undefined) return homeStoragePolicyLabel(choice.data);
        }
    }
}

function readTeamPolicyChoice(row: ApprovalValueRow): string | undefined {
    switch (row.path) {
        case 'sessionCreationPolicy':
        case 'reviewCreationPolicy': {
            const choice = TeamPolicySetInputV1Schema.shape[row.path].safeParse(row.value);
            if (choice.success && choice.data !== undefined) return sessionCreationLabel(choice.data);
            break;
        }
        case 'externalSharingPolicy': {
            const choice = TeamPolicySetInputV1Schema.shape.externalSharingPolicy.safeParse(row.value);
            if (choice.success && choice.data !== undefined) return externalSharingLabel(choice.data);
            break;
        }
        case 'defaultSessionHistoryAccess': {
            const choice = TeamPolicySetInputV1Schema.shape.defaultSessionHistoryAccess.safeParse(row.value);
            if (choice.success && choice.data !== undefined) return historyLabel(choice.data);
            break;
        }
        case 'admissionMode': {
            const choice = TeamPolicySetInputV1Schema.shape.admissionMode.safeParse(row.value);
            if (choice.success && choice.data !== undefined) return teamAdmissionModeLabel(choice.data);
            break;
        }
    }
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
function literalApprovalValue(row: Pick<ApprovalValueRow, 'value' | 'valueFormat' | 'selectedOptions'>, label = ''): string {
    return row.valueFormat === 'clear' ? t('approvals.clearsField', { field: label })
        : row.valueFormat === 'unavailable' ? t('common.unavailable')
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
    extras: ApprovalFieldRow;
    presetSubject?: React.ComponentProps<typeof ActionApprovalFieldsCard>['presetSubject'];
    testID?: string;
}>) {
    const { row, columns, extras } = props;
    const source = row.source;
    const reference = source?.reference;
    const presetSubject = props.presetSubject;
    const admittedName = reference?.kind === 'machinePreset' && presetSubject
        && reference.id === presetSubject.reference.id && reference.homeId === presetSubject.reference.homeId
        ? presetSubject.name : undefined;
    const resolved = useApprovalReferenceReading(admittedName === undefined ? reference : undefined,
        row.value, source?.serverId ?? null, source?.exactRead ? EXACT_READ : undefined);
    const reading = admittedName === undefined ? resolved : { text: admittedName, named: true, session: undefined };
    const label = nameApprovalReferenceLabel(row.label, source?.reference);
    const unnamed = isUnnamedApprovalReference(source?.reference, reading);
    const note = unnamed ? [t('approvals.referenceNameUnavailable'), extras.note].filter(Boolean).join('\n') : extras.note;
    const title = (
        <FieldLayout label={label} columns={columns}>
            <FieldValue value={unnamed ? UNNAMED_REFERENCE_VALUE : readableApprovalReferenceText(source?.reference, reading, source?.referenceText)}
                names={extras.names} note={note} singleLine={extras.singleLine}
                code={!reading.named && extras.kind === 'value' && extras.valueFormat === 'code'} />
        </FieldLayout>
    );
    if (reading.session) return <ApprovalSessionLinkItem title={title} session={reading.session} />;
    return <Item title={title} mode="info" showChevron={false} testID={props.testID} />;
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
function nameApprovalReferenceLabel(label: string, reference: ApprovalReference | undefined): string {
    const handle = /(\s+(id|key|target|selection))+$/i;
    // The slot shows a name, a loading word or an em dash, never the handle itself, so the key is the thing's.
    if (!reference || reference.kind === 'setting' || !handle.test(label)) return label;
    const stem = label.replace(handle, '');
    if (!stem) return label;
    return reference.kind === 'home' && /^server$/i.test(stem) ? t('common.home') : stem;
}

function readApprovalFieldLabel(label: string): string {
    return typeof getTranslationValue(label) === 'string' ? tLoose(label) : label;
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
        // A field title may be a translation key (`approvals.publicLinkFields.*`): it reads in words here too.
        const title = readApprovalFieldLabel(row.title);
        if (row.reference) lines.push({ key: row.path, label: title, value: row.value });
        // The input's own schema version (`v`, or `input.v` under a contributed Action) does not identify the effect.
        else if (row.technical && !row.entries && !/^(input\.)?v$/.test(row.path)
            && !['', '{}', '[]', 'null'].includes(row.value)) lines.push({ key: row.path, label: title, value: row.value });
        if (!row.entries) continue;
        const trail: string[] = [];
        row.entries.forEach((entry, index) => {
            trail.length = entry.depth;
            if (entry.value === null) { trail.push(readApprovalFieldLabel(entry.label)); return; }
            // Versions and empty values do not identify the effect. Exact ids behind resolved
            // names do, so the disclosure retains only those references.
            if (entry.reference || entry.technical && entry.label !== 'V'
                && !['', '{}', '[]', 'null'].includes(entry.value)) {
                lines.push({ key: `${row.path}:${index}`, label: [title, ...trail, readApprovalFieldLabel(entry.label)].join(' › '), value: entry.value });
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
    foldedFacts: {
        gap: theme.space.s8,
    },
    disclosureBody: {
        paddingTop: theme.space.s8,
    },
}));

