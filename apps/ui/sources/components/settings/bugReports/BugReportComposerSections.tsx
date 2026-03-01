import React from 'react';
import { Pressable, View } from 'react-native';

import { parseDoctorSnapshotSafe } from '@happier-dev/protocol';
import { Switch } from '@/components/ui/forms/Switch';
import { Text, TextInput } from '@/components/ui/text/Text';
import { t, type TranslationKey } from '@/text';

import { type BugReportDeploymentType, type BugReportFrequency, type BugReportSeverity } from './bugReportFallback';
import { BugReportChoiceRow } from './BugReportChoiceRow';
import { bugReportComposerStyles } from './bugReportComposerStyles';

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
    placeholderTextColor: string;
}>): React.JSX.Element {
    const acceptedSet = new Set(props.acceptedKinds);
    const selectedSet = new Set(props.selectedKinds);

    const toggleKind = (kind: BugReportDiagnosticsKind, enabled: boolean) => {
        const next = new Set(selectedSet);
        if (enabled) next.add(kind);
        else next.delete(kind);
        props.onSelectedKindsChange(Array.from(next));
    };

    return (
        <View style={bugReportComposerStyles.section}>
            <View style={bugReportComposerStyles.sectionHeader}>
                <Text style={bugReportComposerStyles.sectionTitle}>{t('bugReports.composer.diagnostics.title')}</Text>
                <Text style={bugReportComposerStyles.helperText}>{t('bugReports.composer.diagnostics.subtitle')}</Text>
            </View>

            <View style={bugReportComposerStyles.toggleRows}>
                <View style={bugReportComposerStyles.toggleRow}>
                    <View style={{ flex: 1, gap: 4 }}>
                        <Text style={bugReportComposerStyles.label}>{t('bugReports.composer.diagnostics.includeTitle')}</Text>
                        <Text style={bugReportComposerStyles.helperText}>{t('bugReports.composer.diagnostics.includeSubtitle')}</Text>
                    </View>
                    <Switch value={props.includeDiagnostics} onValueChange={props.onIncludeDiagnosticsChange} />
                </View>

                {props.includeDiagnostics && (
                    <>
                        {DIAGNOSTICS_KIND_OPTIONS.map((option) => {
                            const allowed = acceptedSet.has(option.kind);
                            const selected = selectedSet.has(option.kind);
                            return (
                                <View key={option.kind} style={bugReportComposerStyles.toggleRow}>
                                    <View style={{ flex: 1, gap: 4 }}>
                                        <Text style={bugReportComposerStyles.label}>{t(option.titleKey)}</Text>
                                        <Text style={bugReportComposerStyles.helperText}>
                                            {t(option.detailKey)}
                                            {allowed ? '' : t('bugReports.composer.diagnostics.disabledByServerSuffix')}
                                        </Text>
                                    </View>
                                    <Switch
                                        value={selected && allowed}
                                        onValueChange={(value) => toggleKind(option.kind, value)}
                                        disabled={!allowed}
                                    />
                                </View>
                            );
                        })}

                        {acceptedSet.has('daemon') ? (
                            <View style={bugReportComposerStyles.field}>
                                <Text style={bugReportComposerStyles.label}>{t('bugReports.composer.diagnostics.pasteDoctorJson.title')}</Text>
                                <Text style={bugReportComposerStyles.helperText}>{t('bugReports.composer.diagnostics.pasteDoctorJson.subtitle')}</Text>
                                <TextInput
                                    value={props.pastedCliDoctorSnapshotJson}
                                    onChangeText={props.onPastedCliDoctorSnapshotJsonChange}
                                    placeholder={t('bugReports.composer.diagnostics.pasteDoctorJson.placeholder')}
                                    placeholderTextColor={props.placeholderTextColor}
                                    style={[bugReportComposerStyles.input, bugReportComposerStyles.textArea]}
                                    editable
                                    multiline
                                    numberOfLines={4}
                                    maxLength={200_000}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    textContentType="none"
                                />
                                {props.pastedCliDoctorSnapshotJson.trim().length > 0 ? (
                                    (() => {
                                        const parsed = parseDoctorSnapshotSafe(props.pastedCliDoctorSnapshotJson);
                                        if (!parsed.ok) {
                                            return <Text style={bugReportComposerStyles.errorText}>{t('bugReports.composer.diagnostics.pasteDoctorJson.invalid', { error: parsed.error })}</Text>;
                                        }
                                        return <Text style={bugReportComposerStyles.helperText}>{t('bugReports.composer.diagnostics.pasteDoctorJson.valid')}</Text>;
                                    })()
                                ) : null}
                            </View>
                        ) : null}

                        <Pressable
                            style={[bugReportComposerStyles.previewButton, props.previewDisabled && bugReportComposerStyles.previewButtonDisabled]}
                            onPress={props.onPreviewDiagnostics}
                            disabled={props.previewDisabled}
                            accessibilityRole="button"
                            accessibilityLabel={t('bugReports.composer.diagnostics.previewButton')}
                        >
                            <Text style={bugReportComposerStyles.previewButtonText}>{t('bugReports.composer.diagnostics.previewButton')}</Text>
                        </Pressable>
                    </>
                )}
            </View>
        </View>
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
    placeholderTextColor: string;
    fieldErrors?: Partial<Record<'title' | 'summary', string>>;
    disabled: boolean;
}>): React.JSX.Element {
    return (
        <View style={bugReportComposerStyles.section}>
            <View style={bugReportComposerStyles.sectionHeader}>
                <Text style={bugReportComposerStyles.sectionTitle}>{t('bugReports.composer.issueDetails.title')}</Text>
                <Text style={bugReportComposerStyles.helperText}>{t('bugReports.composer.issueDetails.subtitle')}</Text>
            </View>

                <View style={bugReportComposerStyles.sectionFields}>
                    <View style={bugReportComposerStyles.field}>
                      <Text style={bugReportComposerStyles.label}>{t('bugReports.composer.issueDetails.titleLabel')}</Text>
                      <TextInput
                          value={props.title}
                          onChangeText={props.onTitleChange}
                          placeholder={t('bugReports.composer.issueDetails.titlePlaceholder')}
                        placeholderTextColor={props.placeholderTextColor}
                        style={[bugReportComposerStyles.input, props.fieldErrors?.title ? bugReportComposerStyles.inputError : null]}
                        editable={!props.disabled}
                        maxLength={200}
                    />
                    {props.fieldErrors?.title && props.title.trim().length > 0 && (
                        <Text style={bugReportComposerStyles.errorText}>{props.fieldErrors.title}</Text>
                    )}
                </View>

                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>{t('bugReports.composer.issueDetails.githubUsernameLabel')}</Text>
                    <TextInput
                        value={props.reporterGithubUsername}
                        onChangeText={props.onReporterGithubUsernameChange}
                        placeholder={t('bugReports.composer.issueDetails.githubUsernamePlaceholder')}
                        placeholderTextColor={props.placeholderTextColor}
                        style={bugReportComposerStyles.input}
                        editable={!props.disabled}
                        autoCapitalize="none"
                        autoCorrect={false}
                        maxLength={80}
                    />
                </View>

                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>{t('bugReports.composer.issueDetails.summaryLabel')}</Text>
                    <TextInput
                        value={props.summary}
                        onChangeText={props.onSummaryChange}
                        placeholder={t('bugReports.composer.issueDetails.summaryPlaceholder')}
                        placeholderTextColor={props.placeholderTextColor}
                        style={[
                            bugReportComposerStyles.input,
                            bugReportComposerStyles.textArea,
                            props.fieldErrors?.summary ? bugReportComposerStyles.inputError : null,
                        ]}
                        editable={!props.disabled}
                        multiline
                        numberOfLines={4}
                        maxLength={800}
                    />
                    {props.fieldErrors?.summary && props.summary.trim().length > 0 && (
                        <Text style={bugReportComposerStyles.errorText}>{props.fieldErrors.summary}</Text>
                    )}
                </View>

                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>{t('bugReports.composer.issueDetails.currentBehaviorLabel')}</Text>
                    <TextInput
                        value={props.currentBehavior}
                        onChangeText={props.onCurrentBehaviorChange}
                        placeholder={t('bugReports.composer.issueDetails.currentBehaviorPlaceholder')}
                        placeholderTextColor={props.placeholderTextColor}
                        style={[bugReportComposerStyles.input, bugReportComposerStyles.textArea]}
                        editable={!props.disabled}
                        multiline
                        numberOfLines={4}
                        maxLength={5000}
                    />
                </View>

                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>{t('bugReports.composer.issueDetails.expectedBehaviorLabel')}</Text>
                    <TextInput
                        value={props.expectedBehavior}
                        onChangeText={props.onExpectedBehaviorChange}
                        placeholder={t('bugReports.composer.issueDetails.expectedBehaviorPlaceholder')}
                        placeholderTextColor={props.placeholderTextColor}
                        style={[bugReportComposerStyles.input, bugReportComposerStyles.textArea]}
                        editable={!props.disabled}
                        multiline
                        numberOfLines={4}
                        maxLength={5000}
                    />
                </View>

                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>{t('bugReports.composer.issueDetails.reproductionStepsLabel')}</Text>
                    <TextInput
                        value={props.reproductionStepsText}
                        onChangeText={props.onReproductionStepsTextChange}
                        placeholder={t('bugReports.composer.issueDetails.reproductionStepsPlaceholder')}
                        placeholderTextColor={props.placeholderTextColor}
                        style={[bugReportComposerStyles.input, bugReportComposerStyles.textArea]}
                        editable={!props.disabled}
                        multiline
                        numberOfLines={5}
                        maxLength={4000}
                    />
                </View>

                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>{t('bugReports.composer.issueDetails.whatChangedLabel')}</Text>
                    <TextInput
                        value={props.whatChangedRecently}
                        onChangeText={props.onWhatChangedRecentlyChange}
                        placeholder={t('bugReports.composer.issueDetails.whatChangedPlaceholder')}
                        placeholderTextColor={props.placeholderTextColor}
                        style={[bugReportComposerStyles.input, bugReportComposerStyles.textArea]}
                        editable={!props.disabled}
                        multiline
                        numberOfLines={3}
                        maxLength={2000}
                    />
                </View>
            </View>
        </View>
    );
}

export function BugReportFrequencySeveritySection(props: Readonly<{
    frequency: BugReportFrequency;
    onFrequencyChange: (value: BugReportFrequency) => void;
    severity: BugReportSeverity;
    onSeverityChange: (value: BugReportSeverity) => void;
}>): React.JSX.Element {
    return (
        <View style={bugReportComposerStyles.section}>
            <View style={bugReportComposerStyles.sectionHeader}>
                <Text style={bugReportComposerStyles.sectionTitle}>{t('bugReports.composer.frequencySeverity.title')}</Text>
            </View>

            <View style={bugReportComposerStyles.sectionFields}>
                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>{t('bugReports.composer.frequencySeverity.frequencyLabel')}</Text>
                    <BugReportChoiceRow
                        value={props.frequency}
                        onChange={props.onFrequencyChange}
                        options={[
                            { value: 'always', label: t('bugReports.composer.frequencySeverity.frequency.always') },
                            { value: 'often', label: t('bugReports.composer.frequencySeverity.frequency.often') },
                            { value: 'sometimes', label: t('bugReports.composer.frequencySeverity.frequency.sometimes') },
                            { value: 'once', label: t('bugReports.composer.frequencySeverity.frequency.once') },
                        ]}
                    />
                </View>

                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>{t('bugReports.composer.frequencySeverity.severityLabel')}</Text>
                    <BugReportChoiceRow
                        value={props.severity}
                        onChange={props.onSeverityChange}
                        options={[
                            { value: 'blocker', label: t('bugReports.composer.frequencySeverity.severity.blocker') },
                            { value: 'high', label: t('bugReports.composer.frequencySeverity.severity.high') },
                            { value: 'medium', label: t('bugReports.composer.frequencySeverity.severity.medium') },
                            { value: 'low', label: t('bugReports.composer.frequencySeverity.severity.low') },
                        ]}
                    />
                </View>
            </View>
        </View>
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
        <View style={bugReportComposerStyles.section}>
            <View style={bugReportComposerStyles.sectionHeader}>
                <Text style={bugReportComposerStyles.sectionTitle}>{t('bugReports.composer.environment.title')}</Text>
            </View>

            <View style={bugReportComposerStyles.sectionFields}>
                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>{t('bugReports.composer.environment.appVersionLabel')}</Text>
                    <TextInput value={props.appVersion} onChangeText={props.onAppVersionChange} style={bugReportComposerStyles.input} editable={!props.disabled} />
                </View>

                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>{t('bugReports.composer.environment.platformLabel')}</Text>
                    <TextInput value={props.platformValue} onChangeText={props.onPlatformValueChange} style={bugReportComposerStyles.input} editable={!props.disabled} />
                </View>

                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>{t('bugReports.composer.environment.osVersionLabel')}</Text>
                    <TextInput value={props.osVersion} onChangeText={props.onOsVersionChange} style={bugReportComposerStyles.input} editable={!props.disabled} />
                </View>

                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>{t('bugReports.composer.environment.deviceModelLabel')}</Text>
                    <TextInput value={props.deviceModel} onChangeText={props.onDeviceModelChange} style={bugReportComposerStyles.input} editable={!props.disabled} />
                </View>

                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>{t('bugReports.composer.environment.serverUrlLabel')}</Text>
                    <TextInput
                        value={props.serverUrl}
                        onChangeText={props.onServerUrlChange}
                        style={bugReportComposerStyles.input}
                        editable={!props.disabled}
                        autoCapitalize="none"
                    />
                </View>

                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>{t('bugReports.composer.environment.serverVersionLabel')}</Text>
                    <TextInput
                        value={props.serverVersion}
                        onChangeText={props.onServerVersionChange}
                        style={bugReportComposerStyles.input}
                        editable={!props.disabled}
                    />
                </View>

                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>{t('bugReports.composer.environment.deploymentTypeLabel')}</Text>
                    <BugReportChoiceRow
                        value={props.deploymentType}
                        onChange={props.onDeploymentTypeChange}
                        options={[
                            { value: 'cloud', label: t('bugReports.composer.environment.deploymentType.cloud') },
                            { value: 'self-hosted', label: t('bugReports.composer.environment.deploymentType.selfHosted') },
                            { value: 'enterprise', label: t('bugReports.composer.environment.deploymentType.enterprise') },
                        ]}
                    />
                </View>
            </View>
        </View>
    );
}

export function BugReportConsentSection(props: Readonly<{
    acceptedPrivacyNotice: boolean;
    onAcceptedPrivacyNoticeChange: (value: boolean) => void;
    errorText?: string;
}>): React.JSX.Element {
    return (
        <View style={bugReportComposerStyles.section}>
            <View style={bugReportComposerStyles.sectionHeader}>
                <Text style={bugReportComposerStyles.sectionTitle}>{t('bugReports.composer.consent.title')}</Text>
            </View>

            <View style={bugReportComposerStyles.toggleRows}>
                <View style={bugReportComposerStyles.toggleRow}>
                    <View style={{ flex: 1, gap: 4 }}>
                        <Text style={bugReportComposerStyles.label}>{t('bugReports.composer.consent.understandTitle')}</Text>
                        <Text style={bugReportComposerStyles.helperText}>{t('bugReports.composer.consent.understandSubtitle')}</Text>
                    </View>
                    <Switch value={props.acceptedPrivacyNotice} onValueChange={props.onAcceptedPrivacyNoticeChange} />
                </View>
                {props.errorText ? (
                    <Text style={bugReportComposerStyles.errorText}>{props.errorText}</Text>
                ) : null}
            </View>
        </View>
    );
}
