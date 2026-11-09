import React from 'react';
import { resolveBugReportLogSelection, type BugReportLogSelection } from '@happier-dev/protocol/bugs/reports/machineDiagnostics';
import type { collectBugReportDiagnosticsArtifacts } from './bugReportDiagnostics';

import { parseDoctorSnapshotSafe } from '@happier-dev/protocol/diagnostics/doctorSnapshot';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Switch } from '@/components/ui/forms/Switch';
import { CountedDisclosureItem } from '@/components/ui/lists/CountedDisclosureItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { t, type TranslationKey } from '@/text';

import { BUG_REPORT_CURRENT_BEHAVIOR_MAX_LENGTH } from './bugReportComposerDraft';

import { type BugReportDeploymentType, type BugReportFrequency, type BugReportSeverity } from './bugReportFallback';

const LOG_OPTIONS: ReadonlyArray<{ kind: keyof BugReportLogSelection; title: TranslationKey; detail: TranslationKey }> = [
    { kind: 'daemon', title: 'bugReports.composer.logOptions.daemonTitle', detail: 'bugReports.composer.logOptions.daemonDetail' },
    { kind: 'session', title: 'bugReports.composer.logOptions.sessionTitle', detail: 'bugReports.composer.logOptions.sessionDetail' },
    { kind: 'provider', title: 'bugReports.composer.logOptions.providerTitle', detail: 'bugReports.composer.logOptions.providerDetail' },
];

/** A labelled text field row: the field sits beside a short label and beneath a long one. */
function BugReportFieldRow(props: Readonly<{
    label: string;
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    multiline?: boolean;
    minLines?: number;
    maxLength?: number;
    error?: string | null;
    disabled?: boolean;
    monospace?: boolean;
    autoCapitalize?: 'none' | 'sentences' | 'words';
    testID?: string;
    showDivider?: boolean;
}>) {
    return (
        <Item
            title={props.label}
            titleLines={0}
            showDivider={props.showDivider}
            showChevron={false}
            accessoryLayout={props.multiline ? 'stacked' : 'adaptive'}
            rightElement={(
                <FieldTextInput
                    testID={props.testID}
                    value={props.value}
                    onChangeText={props.onChange}
                    accessibilityLabel={props.label}
                    accessibilityHint={props.placeholder}
                    placeholder={props.placeholder}
                    multiline={props.multiline}
                    minLines={props.minLines}
                    maxLength={props.maxLength}
                    error={props.error}
                    editable={props.disabled ? false : undefined}
                    monospace={props.monospace}
                    autoCapitalize={props.autoCapitalize ?? 'sentences'}
                />
            )}
        />
    );
}

export function BugReportDiagnosticsSection(props: Readonly<{
    includeDiagnostics: boolean;
    onIncludeDiagnosticsChange: (value: boolean) => void;
    logSelection: BugReportLogSelection;
    onLogSelectionChange: (selection: BugReportLogSelection) => void;
    collectionStatuses?: Awaited<ReturnType<typeof collectBugReportDiagnosticsArtifacts>>['collectionStatuses'];
    onPreviewDiagnostics: () => void;
    previewDisabled: boolean;
    disabled?: boolean;
}>): React.JSX.Element {
    const technicalOnly = !Object.values(props.logSelection).some(Boolean);
    return (
        <ItemGroup
            title={t('bugReports.composer.diagnostics.title')}
            description={t('bugReports.composer.diagnostics.subtitle')}
            action={props.includeDiagnostics ? (
                <RoundButton
                    testID="bug-report-preview-diagnostics"
                    size="small"
                    display="inverted"
                    title={t('bugReports.composer.diagnostics.previewButton')}
                    disabled={props.previewDisabled}
                    onPress={props.onPreviewDiagnostics}
                />
            ) : undefined}
        >
            <Item
                title={t('bugReports.composer.diagnostics.includeTitle')}
                subtitle={t('bugReports.composer.diagnostics.includeSubtitle')}
                subtitleLines={0}
                showChevron={false}
                rightElement={<Switch
                    accessibilityLabel={t('bugReports.composer.diagnostics.includeTitle')}
                    accessibilityHint={t('bugReports.composer.diagnostics.includeSubtitle')}
                    value={props.includeDiagnostics}
                    disabled={props.disabled}
                    onValueChange={props.onIncludeDiagnosticsChange}
                />}
            />
            {props.includeDiagnostics ? <>
                {props.collectionStatuses?.scope ? <Item title={t('bugReports.composer.scopeChanged')} titleLines={0} showChevron={false} /> : null}
                <Item
                    title={t('bugReports.composer.logOptions.technicalOnly')}
                    subtitle={t('bugReports.composer.logOptions.technicalOnlyDetail')}
                    subtitleLines={0}
                    showChevron={false}
                    rightElement={<Switch
                        testID="bug-report-technical-only"
                        accessibilityLabel={t('bugReports.composer.logOptions.technicalOnly')}
                        accessibilityHint={t('bugReports.composer.logOptions.technicalOnlyDetail')}
                        value={technicalOnly}
                        disabled={props.disabled}
                        onValueChange={value => props.onLogSelectionChange(value
                            ? { daemon: false, session: false, provider: false }
                            : resolveBugReportLogSelection())}
                    />}
                />
                {LOG_OPTIONS.map(option => {
                    const status = props.collectionStatuses?.[option.kind]?.status;
                    return <Item
                        key={option.kind}
                        title={t(option.title)}
                        subtitle={[t(option.detail), status ? t(`bugReports.composer.collection.${status}`) : null].filter(Boolean).join(' ')}
                        subtitleLines={0}
                        showChevron={false}
                        rightElement={<Switch
                            testID={`bug-report-log-${option.kind}`}
                            accessibilityLabel={t(option.title)}
                            accessibilityHint={t(option.detail)}
                            value={props.logSelection[option.kind]}
                            disabled={props.disabled}
                            onValueChange={value => props.onLogSelectionChange({ ...props.logSelection, [option.kind]: value })}
                        />}
                    />;
                })}
            </> : null}
        </ItemGroup>
    );
}

export function BugReportDoctorSnapshotField(props: Readonly<{
    value: string;
    onChange: (value: string) => void;
    disabled: boolean;
}>): React.JSX.Element {
    const pasted = props.value.trim() ? parseDoctorSnapshotSafe(props.value) : null;
    return <Item
        title={t('bugReports.composer.diagnostics.pasteDoctorJson.title')}
        subtitle={pasted?.ok ? t('bugReports.composer.diagnostics.pasteDoctorJson.valid') : t('bugReports.composer.diagnostics.pasteDoctorJson.subtitle')}
        subtitleLines={0}
        showChevron={false}
        accessoryLayout="stacked"
        rightElement={<FieldTextInput
            testID="bug-report-doctor-json"
            value={props.value}
            onChangeText={props.onChange}
            accessibilityLabel={t('bugReports.composer.diagnostics.pasteDoctorJson.title')}
            accessibilityHint={t('bugReports.composer.diagnostics.pasteDoctorJson.subtitle')}
            placeholder={t('bugReports.composer.diagnostics.pasteDoctorJson.placeholder')}
            error={pasted && !pasted.ok ? t('bugReports.composer.diagnostics.pasteDoctorJson.invalid', { error: pasted.error }) : null}
            multiline minLines={4} maxLength={200_000} monospace autoCapitalize="none"
            editable={!props.disabled}
        />}
    />;
}

export function BugReportIssueDetailsSection(props: Readonly<{
    title: string;
    onTitleChange: (value: string) => void;
    summary: string;
    onSummaryChange: (value: string) => void;
    fieldErrors?: Partial<Record<'title' | 'summary', string>>;
    disabled: boolean;
}>): React.JSX.Element {
    // A field's refusal shows once the person has typed into it; an untouched form says what is
    // required at the submit button instead.
    const titleError = props.fieldErrors?.title && props.title.trim().length > 0 ? props.fieldErrors.title : null;
    const summaryError = props.fieldErrors?.summary && props.summary.trim().length > 0 ? props.fieldErrors.summary : null;
    return (
        <ItemGroup
            title={t('bugReports.composer.issueDetails.title')}
            description={t('bugReports.composer.issueDetails.subtitle')}
        >
            <BugReportFieldRow
                testID="bug-report-title"
                label={t('bugReports.composer.issueDetails.titleLabel')}
                value={props.title}
                onChange={props.onTitleChange}
                placeholder={t('bugReports.composer.issueDetails.titlePlaceholder')}
                maxLength={200}
                error={titleError}
                disabled={props.disabled}
            />
            <BugReportFieldRow
                testID="bug-report-summary"
                label={t('bugReports.composer.issueDetails.summaryLabel')}
                value={props.summary}
                onChange={props.onSummaryChange}
                placeholder={t('bugReports.composer.issueDetails.summaryPlaceholder')}
                multiline
                maxLength={800}
                error={summaryError}
                disabled={props.disabled}
                showDivider={false}
            />
        </ItemGroup>
    );
}

/** The optional fields, together under one heading that says they are optional, instead of a "(optional)" on each label. */
export function BugReportMoreDetailSection(props: Readonly<{
    showCurrentBehavior?: boolean;
    children?: React.ReactNode;
    reporterGithubUsername: string;
    onReporterGithubUsernameChange: (value: string) => void;
    currentBehavior: string;
    onCurrentBehaviorChange: (value: string) => void;
    expectedBehavior: string;
    onExpectedBehaviorChange: (value: string) => void;
    reproductionStepsText: string;
    onReproductionStepsTextChange: (value: string) => void;
    whatChangedRecently: string;
    onWhatChangedRecentlyChange: (value: string) => void;
    disabled: boolean;
}>): React.JSX.Element {
    const currentBehaviorField = (
        <BugReportFieldRow
            label={t('bugReports.composer.issueDetails.currentBehaviorLabel')}
            value={props.currentBehavior}
            onChange={props.onCurrentBehaviorChange}
            placeholder={t('bugReports.composer.issueDetails.currentBehaviorPlaceholder')}
            multiline
            maxLength={BUG_REPORT_CURRENT_BEHAVIOR_MAX_LENGTH}
            disabled={props.disabled}
        />
    );
    const filledCount = [props.showCurrentBehavior ? '': props.currentBehavior, props.expectedBehavior, props.reproductionStepsText,
        props.whatChangedRecently, props.reporterGithubUsername].filter((value) => value.trim().length > 0).length;
    return (
        <ItemGroup
            title={t('bugReports.composer.issueDetails.moreDetailTitle')}
            description={t('bugReports.composer.issueDetails.moreDetailDescription')}
        >
            {props.showCurrentBehavior ? currentBehaviorField : null}
            <CountedDisclosureItem
                testID="bug-report-more-detail"
                title={t('bugReports.composer.issueDetails.addMoreDetail')}
                subtitle={filledCount > 0 ? t('bugReports.composer.issueDetails.filledCount', { count: filledCount }) : undefined}
            >
            {!props.showCurrentBehavior ? currentBehaviorField : null}
            <BugReportFieldRow
                label={t('bugReports.composer.issueDetails.expectedBehaviorLabel')}
                value={props.expectedBehavior}
                onChange={props.onExpectedBehaviorChange}
                placeholder={t('bugReports.composer.issueDetails.expectedBehaviorPlaceholder')}
                multiline
                maxLength={5000}
                disabled={props.disabled}
            />
            <BugReportFieldRow
                label={t('bugReports.composer.issueDetails.reproductionStepsLabel')}
                value={props.reproductionStepsText}
                onChange={props.onReproductionStepsTextChange}
                placeholder={t('bugReports.composer.issueDetails.reproductionStepsPlaceholder')}
                multiline
                minLines={4}
                maxLength={4000}
                disabled={props.disabled}
            />
            <BugReportFieldRow
                label={t('bugReports.composer.issueDetails.whatChangedLabel')}
                value={props.whatChangedRecently}
                onChange={props.onWhatChangedRecentlyChange}
                placeholder={t('bugReports.composer.issueDetails.whatChangedPlaceholder')}
                multiline
                maxLength={2000}
                disabled={props.disabled}
            />
            <BugReportFieldRow
                label={t('bugReports.composer.issueDetails.githubUsernameLabel')}
                value={props.reporterGithubUsername}
                onChange={props.onReporterGithubUsernameChange}
                placeholder={t('bugReports.composer.issueDetails.githubUsernamePlaceholder')}
                maxLength={80}
                autoCapitalize="none"
                disabled={props.disabled}
                showDivider={false}
            />
            {props.children}
            </CountedDisclosureItem>
        </ItemGroup>
    );
}

export function BugReportFrequencySeveritySection(props: Readonly<{
    frequency: BugReportFrequency;
    onFrequencyChange: (value: BugReportFrequency) => void;
    severity: BugReportSeverity;
    onSeverityChange: (value: BugReportSeverity) => void;
    disabled?: boolean;
}>): React.JSX.Element {
    return (
        <>
            <SegmentedChoiceItem<BugReportFrequency>
                disabled={props.disabled}
                testIDPrefix="bug-report-frequency"
                title={t('bugReports.composer.frequencySeverity.frequencyLabel')}
                value={props.frequency}
                onChange={props.onFrequencyChange}
                options={[
                    { id: 'always', label: t('bugReports.composer.frequencySeverity.frequency.always') },
                    { id: 'often', label: t('bugReports.composer.frequencySeverity.frequency.often') },
                    { id: 'sometimes', label: t('bugReports.composer.frequencySeverity.frequency.sometimes') },
                    { id: 'once', label: t('bugReports.composer.frequencySeverity.frequency.once') },
                ]}
            />
            <SegmentedChoiceItem<BugReportSeverity>
                disabled={props.disabled}
                testIDPrefix="bug-report-severity"
                title={t('bugReports.composer.frequencySeverity.severityLabel')}
                value={props.severity}
                onChange={props.onSeverityChange}
                options={[
                    { id: 'blocker', label: t('bugReports.composer.frequencySeverity.severity.blocker') },
                    { id: 'high', label: t('bugReports.composer.frequencySeverity.severity.high') },
                    { id: 'medium', label: t('bugReports.composer.frequencySeverity.severity.medium') },
                    { id: 'low', label: t('bugReports.composer.frequencySeverity.severity.low') },
                ]}
            />
        </>
    );
}

export function BugReportEnvironmentSection(props: Readonly<{
    appVersion: string;
    onAppVersionChange: (value: string) => void;
    platformValue: string;
    onPlatformValueChange: (value: string) => void;
    osVersion: string;
    onOsVersionChange: (value: string) => void;
    deviceModel: string;
    onDeviceModelChange: (value: string) => void;
    serverUrl: string;
    onServerUrlChange: (value: string) => void;
    serverVersion: string;
    onServerVersionChange: (value: string) => void;
    deploymentType: BugReportDeploymentType;
    onDeploymentTypeChange: (value: BugReportDeploymentType) => void;
    children?: React.ReactNode;
    disabled: boolean;
}>): React.JSX.Element {
    return (
        <ItemGroup
            title={t('bugReports.composer.technicalInformation')}
            description={t('bugReports.composer.environment.description')}
        >
            <CountedDisclosureItem
                testID="bug-report-technical-information"
                // What is sent, at a glance; the fields open in place to correct it.
                title={[
                    props.appVersion,
                    props.platformValue,
                    props.osVersion,
                    props.deviceModel,
                    props.deploymentType === 'cloud'
                        ? t('bugReports.composer.environment.deploymentType.cloud')
                        : props.deploymentType === 'enterprise'
                            ? t('bugReports.composer.environment.deploymentType.enterprise')
                            : t('bugReports.composer.environment.deploymentType.selfHosted'),
                ].map((value) => value.trim()).filter((value) => value.length > 0).join(' · ')}
                subtitle={props.serverUrl.trim() || undefined}
            >
            <BugReportFieldRow label={t('bugReports.composer.environment.appVersionLabel')} value={props.appVersion} onChange={props.onAppVersionChange} disabled={props.disabled} autoCapitalize="none" />
            <BugReportFieldRow label={t('bugReports.composer.environment.platformLabel')} value={props.platformValue} onChange={props.onPlatformValueChange} disabled={props.disabled} autoCapitalize="none" />
            <BugReportFieldRow label={t('bugReports.composer.environment.osVersionLabel')} value={props.osVersion} onChange={props.onOsVersionChange} disabled={props.disabled} autoCapitalize="none" />
            <BugReportFieldRow label={t('bugReports.composer.environment.deviceModelLabel')} value={props.deviceModel} onChange={props.onDeviceModelChange} disabled={props.disabled} autoCapitalize="none" />
            <BugReportFieldRow label={t('bugReports.composer.environment.serverUrlLabel')} value={props.serverUrl} onChange={props.onServerUrlChange} disabled={props.disabled} autoCapitalize="none" monospace />
            <BugReportFieldRow label={t('bugReports.composer.environment.serverVersionLabel')} value={props.serverVersion} onChange={props.onServerVersionChange} disabled={props.disabled} autoCapitalize="none" />
            <SegmentedChoiceItem<BugReportDeploymentType>
                disabled={props.disabled}
                testIDPrefix="bug-report-deployment"
                title={t('bugReports.composer.environment.deploymentTypeLabel')}
                value={props.deploymentType}
                onChange={props.onDeploymentTypeChange}
                options={[
                    { id: 'cloud', label: t('bugReports.composer.environment.deploymentType.cloud') },
                    { id: 'self-hosted', label: t('bugReports.composer.environment.deploymentType.selfHosted') },
                    { id: 'enterprise', label: t('bugReports.composer.environment.deploymentType.enterprise') },
                ]}
            />
            {props.children}
            </CountedDisclosureItem>
        </ItemGroup>
    );
}

export function BugReportConsentSection(props: Readonly<{
    acceptedPrivacyNotice: boolean;
    onAcceptedPrivacyNoticeChange: (value: boolean) => void;
    errorText?: string;
}>): React.JSX.Element {
    return (
        <ItemGroup title={t('bugReports.composer.consent.title')}>
            <Item
                title={t('bugReports.composer.consent.understandTitle')}
                titleLines={0}
                // The refusal replaces the guidance so the row says what is missing, once.
                subtitle={props.errorText ?? t('bugReports.composer.consent.understandSubtitle')}
                subtitleLines={0}
                showChevron={false}
                rightElement={(
                    // A consent control that announces as a bare "switch" asks for agreement it
                    // never stated the terms of, so this one is named even though it sits beside
                    // its label.
                    <Switch
                        accessibilityLabel={t('bugReports.composer.consent.understandTitle')}
                        accessibilityHint={t('bugReports.composer.consent.understandSubtitle')}
                        value={props.acceptedPrivacyNotice}
                        onValueChange={props.onAcceptedPrivacyNoticeChange}
                    />
                )}
            />
        </ItemGroup>
    );
}
