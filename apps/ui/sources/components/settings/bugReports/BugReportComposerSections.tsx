import React from 'react';

import { parseDoctorSnapshotSafe } from '@happier-dev/protocol/diagnostics/doctorSnapshot';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { t, type TranslationKey } from '@/text';

import { type BugReportDeploymentType, type BugReportFrequency, type BugReportSeverity } from './bugReportFallback';

type BugReportDiagnosticsKind = 'ui-mobile' | 'daemon' | 'server' | 'stack-service';

const DIAGNOSTICS_KIND_OPTIONS: Array<{
    kind: BugReportDiagnosticsKind;
    titleKey: TranslationKey;
    detailKey: TranslationKey;
}> = [
    {
        kind: 'ui-mobile',
        titleKey: 'bugReports.composer.diagnostics.kinds.app.title',
        detailKey: 'bugReports.composer.diagnostics.kinds.app.detail',
    },
    {
        kind: 'daemon',
        titleKey: 'bugReports.composer.diagnostics.kinds.daemon.title',
        detailKey: 'bugReports.composer.diagnostics.kinds.daemon.detail',
    },
    {
        kind: 'stack-service',
        titleKey: 'bugReports.composer.diagnostics.kinds.stackService.title',
        detailKey: 'bugReports.composer.diagnostics.kinds.stackService.detail',
    },
    {
        kind: 'server',
        titleKey: 'bugReports.composer.diagnostics.kinds.server.title',
        detailKey: 'bugReports.composer.diagnostics.kinds.server.detail',
    },
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
    acceptedKinds: string[];
    selectedKinds: string[];
    onSelectedKindsChange: (kinds: string[]) => void;
    onPreviewDiagnostics: () => void;
    previewDisabled: boolean;
    pastedCliDoctorSnapshotJson: string;
    onPastedCliDoctorSnapshotJsonChange: (value: string) => void;
}>): React.JSX.Element {
    const acceptedSet = new Set(props.acceptedKinds);
    const selectedSet = new Set(props.selectedKinds);

    const toggleKind = (kind: BugReportDiagnosticsKind, enabled: boolean) => {
        const next = new Set(selectedSet);
        if (enabled) next.add(kind);
        else next.delete(kind);
        props.onSelectedKindsChange(Array.from(next));
    };

    const pasted = props.pastedCliDoctorSnapshotJson.trim().length > 0
        ? parseDoctorSnapshotSafe(props.pastedCliDoctorSnapshotJson)
        : null;

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
                rightElement={(
                    <Switch
                        accessibilityLabel={t('bugReports.composer.diagnostics.includeTitle')}
                        value={props.includeDiagnostics}
                        onValueChange={props.onIncludeDiagnosticsChange}
                    />
                )}
            />
            {props.includeDiagnostics ? DIAGNOSTICS_KIND_OPTIONS.map((option) => {
                const allowed = acceptedSet.has(option.kind);
                const selected = selectedSet.has(option.kind);
                return (
                    <Item
                        key={option.kind}
                        title={t(option.titleKey)}
                        subtitle={`${t(option.detailKey)}${allowed ? '' : t('bugReports.composer.diagnostics.disabledByServerSuffix')}`}
                        subtitleLines={0}
                        showChevron={false}
                        rightElement={(
                            <Switch
                                accessibilityLabel={t(option.titleKey)}
                                value={selected && allowed}
                                onValueChange={(value) => toggleKind(option.kind, value)}
                                disabled={!allowed}
                            />
                        )}
                    />
                );
            }) : null}
            {props.includeDiagnostics && acceptedSet.has('daemon') ? (
                <Item
                    title={t('bugReports.composer.diagnostics.pasteDoctorJson.title')}
                    // The field shows its own refusal; the row says what the paste is for, or that it is accepted.
                    subtitle={pasted?.ok
                        ? t('bugReports.composer.diagnostics.pasteDoctorJson.valid')
                        : t('bugReports.composer.diagnostics.pasteDoctorJson.subtitle')}
                    subtitleLines={0}
                    showChevron={false}
                    accessoryLayout="stacked"
                    rightElement={(
                        <FieldTextInput
                            testID="bug-report-doctor-json"
                            value={props.pastedCliDoctorSnapshotJson}
                            onChangeText={props.onPastedCliDoctorSnapshotJsonChange}
                            accessibilityLabel={t('bugReports.composer.diagnostics.pasteDoctorJson.title')}
                            placeholder={t('bugReports.composer.diagnostics.pasteDoctorJson.placeholder')}
                            error={pasted && !pasted.ok ? t('bugReports.composer.diagnostics.pasteDoctorJson.invalid', { error: pasted.error }) : null}
                            multiline
                            minLines={4}
                            maxLength={200_000}
                            monospace
                        />
                    )}
                />
            ) : null}
        </ItemGroup>
    );
}

export function BugReportIssueDetailsSection(props: Readonly<{
    title: string;
    onTitleChange: (value: string) => void;
    reporterGithubUsername: string;
    onReporterGithubUsernameChange: (value: string) => void;
    summary: string;
    onSummaryChange: (value: string) => void;
    currentBehavior: string;
    onCurrentBehaviorChange: (value: string) => void;
    expectedBehavior: string;
    onExpectedBehaviorChange: (value: string) => void;
    reproductionStepsText: string;
    onReproductionStepsTextChange: (value: string) => void;
    whatChangedRecently: string;
    onWhatChangedRecentlyChange: (value: string) => void;
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
            />
            <BugReportFieldRow
                label={t('bugReports.composer.issueDetails.currentBehaviorLabel')}
                value={props.currentBehavior}
                onChange={props.onCurrentBehaviorChange}
                placeholder={t('bugReports.composer.issueDetails.currentBehaviorPlaceholder')}
                multiline
                maxLength={5000}
                disabled={props.disabled}
            />
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
            />
        </ItemGroup>
    );
}

export function BugReportFrequencySeveritySection(props: Readonly<{
    frequency: BugReportFrequency;
    onFrequencyChange: (value: BugReportFrequency) => void;
    severity: BugReportSeverity;
    onSeverityChange: (value: BugReportSeverity) => void;
}>): React.JSX.Element {
    return (
        <ItemGroup title={t('bugReports.composer.frequencySeverity.title')}>
            <SegmentedChoiceItem<BugReportFrequency>
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
        </ItemGroup>
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
    disabled: boolean;
}>): React.JSX.Element {
    return (
        <ItemGroup
            title={t('bugReports.composer.environment.title')}
            description={t('bugReports.composer.environment.description')}
        >
            <BugReportFieldRow label={t('bugReports.composer.environment.appVersionLabel')} value={props.appVersion} onChange={props.onAppVersionChange} disabled={props.disabled} autoCapitalize="none" />
            <BugReportFieldRow label={t('bugReports.composer.environment.platformLabel')} value={props.platformValue} onChange={props.onPlatformValueChange} disabled={props.disabled} autoCapitalize="none" />
            <BugReportFieldRow label={t('bugReports.composer.environment.osVersionLabel')} value={props.osVersion} onChange={props.onOsVersionChange} disabled={props.disabled} autoCapitalize="none" />
            <BugReportFieldRow label={t('bugReports.composer.environment.deviceModelLabel')} value={props.deviceModel} onChange={props.onDeviceModelChange} disabled={props.disabled} autoCapitalize="none" />
            <BugReportFieldRow label={t('bugReports.composer.environment.serverUrlLabel')} value={props.serverUrl} onChange={props.onServerUrlChange} disabled={props.disabled} autoCapitalize="none" monospace />
            <BugReportFieldRow label={t('bugReports.composer.environment.serverVersionLabel')} value={props.serverVersion} onChange={props.onServerVersionChange} disabled={props.disabled} autoCapitalize="none" />
            <SegmentedChoiceItem<BugReportDeploymentType>
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
                        value={props.acceptedPrivacyNotice}
                        onValueChange={props.onAcceptedPrivacyNoticeChange}
                    />
                )}
            />
        </ItemGroup>
    );
}
