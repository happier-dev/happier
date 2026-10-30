import React from 'react';
import { Pressable, View } from 'react-native';

import { parseDoctorSnapshotSafe, resolveBugReportLogSelection, type BugReportLogSelection } from '@happier-dev/protocol';
import { Switch } from '@/components/ui/forms/Switch';
import { Text, TextInput } from '@/components/ui/text/Text';
import { t, type TranslationKey } from '@/text';
import type { collectBugReportDiagnosticsArtifacts } from './bugReportDiagnostics';

import { type BugReportDeploymentType, type BugReportFrequency, type BugReportSeverity } from './bugReportFallback';
import { BugReportChoiceRow } from './BugReportChoiceRow';
import { bugReportComposerStyles } from './bugReportComposerStyles';
import { BUG_REPORT_CURRENT_BEHAVIOR_MAX_LENGTH } from './bugReportComposerDraft';
import { BugReportExpandableSection } from './BugReportExpandableSection';

const LOG_OPTIONS: ReadonlyArray<{ kind: keyof BugReportLogSelection; title: TranslationKey; detail: TranslationKey }> = [
    { kind: 'daemon', title: 'bugReports.composer.logOptions.daemonTitle', detail: 'bugReports.composer.logOptions.daemonDetail' },
    { kind: 'session', title: 'bugReports.composer.logOptions.sessionTitle', detail: 'bugReports.composer.logOptions.sessionDetail' },
    { kind: 'provider', title: 'bugReports.composer.logOptions.providerTitle', detail: 'bugReports.composer.logOptions.providerDetail' },
];

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
    return <View style={bugReportComposerStyles.section}>
        <View style={bugReportComposerStyles.toggleRow}>
            <View style={{ flex: 1, gap: 4 }}>
                <Text style={bugReportComposerStyles.sectionTitle}>{t('bugReports.composer.diagnostics.includeTitle')}</Text>
                <Text style={bugReportComposerStyles.helperText}>{t('bugReports.composer.diagnostics.includeSubtitle')}</Text>
            </View>
            <Switch accessibilityLabel={t('bugReports.composer.diagnostics.includeTitle')} value={props.includeDiagnostics} onValueChange={props.onIncludeDiagnosticsChange} disabled={props.disabled} />
        </View>
        {props.includeDiagnostics ? <>
            {props.collectionStatuses?.scope ? <Text style={bugReportComposerStyles.helperText}>{t('bugReports.composer.scopeChanged')}</Text> : null}
            <View style={bugReportComposerStyles.toggleRow}>
                <View style={{ flex: 1, gap: 4 }}>
                    <Text style={bugReportComposerStyles.label}>{t('bugReports.composer.logOptions.technicalOnly')}</Text>
                    <Text style={bugReportComposerStyles.helperText}>{t('bugReports.composer.logOptions.technicalOnlyDetail')}</Text>
                </View>
                <Switch accessibilityLabel={t('bugReports.composer.logOptions.technicalOnly')}
                    accessibilityHint={t('bugReports.composer.logOptions.technicalOnlyDetail')} testID="bug-report-technical-only"  value={technicalOnly} disabled={props.disabled}
                    onValueChange={(value) => props.onLogSelectionChange(value
                        ? { daemon: false, session: false, provider: false }
                        : resolveBugReportLogSelection())} />
            </View>
            {LOG_OPTIONS.map((option) => {
                const status = props.collectionStatuses?.[option.kind]?.status;
                return <View key={option.kind} style={bugReportComposerStyles.toggleRow}>
                    <View style={{ flex: 1, gap: 4 }}>
                        <Text style={bugReportComposerStyles.label}>{t(option.title)}</Text>
                        <Text style={bugReportComposerStyles.helperText}>{t(option.detail)}</Text>
                        {status ? <Text style={bugReportComposerStyles.helperText}>{t(`bugReports.composer.collection.${status}`)}</Text> : null}
                    </View>
                    <Switch accessibilityLabel={t(option.title)} accessibilityHint={t(option.detail)} testID={`bug-report-log-${option.kind}`} value={props.logSelection[option.kind]}
                        disabled={props.disabled === true}
                        onValueChange={(value) => props.onLogSelectionChange({ ...props.logSelection, [option.kind]: value })} />
                </View>;
            })}
            <Pressable style={[bugReportComposerStyles.previewButton, props.previewDisabled && bugReportComposerStyles.previewButtonDisabled]}
                onPress={props.onPreviewDiagnostics} disabled={props.previewDisabled} accessibilityRole="button"
                accessibilityLabel={t('bugReports.composer.diagnostics.previewButton')}>
                <Text style={bugReportComposerStyles.previewButtonText}>{t('bugReports.composer.diagnostics.previewButton')}</Text>
            </Pressable>
        </> : null}
    </View>;
}

export function BugReportDoctorSnapshotField(props: Readonly<{
    value: string;
    onChange: (value: string) => void;
    placeholderTextColor: string;
    disabled: boolean;
}>): React.JSX.Element {
    const parsed = props.value.trim() ? parseDoctorSnapshotSafe(props.value) : null;
    return <View style={bugReportComposerStyles.field}>
        <Text style={bugReportComposerStyles.label}>{t('bugReports.composer.diagnostics.pasteDoctorJson.title')}</Text>
        <Text style={bugReportComposerStyles.helperText}>{t('bugReports.composer.diagnostics.pasteDoctorJson.subtitle')}</Text>
        <TextInput accessibilityLabel={t('bugReports.composer.diagnostics.pasteDoctorJson.title')} value={props.value} onChangeText={props.onChange}
            placeholder={t('bugReports.composer.diagnostics.pasteDoctorJson.placeholder')}
            placeholderTextColor={props.placeholderTextColor}
            style={[bugReportComposerStyles.input, bugReportComposerStyles.textArea]}
            editable={!props.disabled} multiline numberOfLines={4} maxLength={200_000}
            autoCapitalize="none" autoCorrect={false} textContentType="none" />
        {parsed && !parsed.ok ? <Text style={bugReportComposerStyles.errorText}>
            {t('bugReports.composer.diagnostics.pasteDoctorJson.invalid', { error: parsed.error })}
        </Text> : null}
    </View>;
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
    children?: React.ReactNode;
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
                      <TextInput accessibilityLabel={t('bugReports.composer.issueDetails.titleLabel')}
                          value={props.title}
                          onChangeText={props.onTitleChange}
                          placeholder={t('bugReports.composer.issueDetails.titlePlaceholder')}
                        placeholderTextColor={props.placeholderTextColor}
                        style={[bugReportComposerStyles.input, props.fieldErrors?.title && props.title.trim().length > 0 ? bugReportComposerStyles.inputError : null]}
                        editable={!props.disabled}
                        maxLength={200}
                    />
                    {props.fieldErrors?.title && props.title.trim().length > 0 && (
                        <Text style={bugReportComposerStyles.errorText}>{props.fieldErrors.title}</Text>
                    )}
                </View>

                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>{t('bugReports.composer.issueDetails.summaryLabel')}</Text>
                    <TextInput accessibilityLabel={t('bugReports.composer.issueDetails.summaryLabel')}
                        value={props.summary}
                        onChangeText={props.onSummaryChange}
                        placeholder={t('bugReports.composer.issueDetails.summaryPlaceholder')}
                        placeholderTextColor={props.placeholderTextColor}
                        style={[
                            bugReportComposerStyles.input,
                            bugReportComposerStyles.textArea,
                            props.fieldErrors?.summary && props.summary.trim().length > 0 ? bugReportComposerStyles.inputError : null,
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

                <BugReportExpandableSection title={t('bugReports.composer.addMoreDetails')} testID="bug-report-more-details">
                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>{t('bugReports.composer.issueDetails.githubUsernameLabel')}</Text>
                    <TextInput accessibilityLabel={t('bugReports.composer.issueDetails.githubUsernameLabel')}
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
                    <Text style={bugReportComposerStyles.label}>{t('bugReports.composer.issueDetails.currentBehaviorLabel')}</Text>
                    <TextInput accessibilityLabel={t('bugReports.composer.issueDetails.currentBehaviorLabel')}
                        value={props.currentBehavior}
                        onChangeText={props.onCurrentBehaviorChange}
                        placeholder={t('bugReports.composer.issueDetails.currentBehaviorPlaceholder')}
                        placeholderTextColor={props.placeholderTextColor}
                        style={[bugReportComposerStyles.input, bugReportComposerStyles.textArea]}
                        editable={!props.disabled}
                        multiline
                        numberOfLines={4}
                        maxLength={BUG_REPORT_CURRENT_BEHAVIOR_MAX_LENGTH}
                    />
                </View>

                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>{t('bugReports.composer.issueDetails.expectedBehaviorLabel')}</Text>
                    <TextInput accessibilityLabel={t('bugReports.composer.issueDetails.expectedBehaviorLabel')}
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
                    <TextInput accessibilityLabel={t('bugReports.composer.issueDetails.reproductionStepsLabel')}
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
                    <TextInput accessibilityLabel={t('bugReports.composer.issueDetails.whatChangedLabel')}
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
                {props.children}
                </BugReportExpandableSection>
            </View>
        </View>
    );
}

export function BugReportFrequencySeveritySection(props: Readonly<{
    frequency: BugReportFrequency;
    onFrequencyChange: (value: BugReportFrequency) => void;
    severity: BugReportSeverity;
    onSeverityChange: (value: BugReportSeverity) => void;
    embedded?: boolean;
}>): React.JSX.Element {
    return (
        <View style={props.embedded ? bugReportComposerStyles.sectionFields : bugReportComposerStyles.section}>
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
    embedded?: boolean;
}>): React.JSX.Element {
    return (
        <View style={props.embedded ? bugReportComposerStyles.sectionFields : bugReportComposerStyles.section}>
            <View style={bugReportComposerStyles.sectionHeader}>
                <Text style={bugReportComposerStyles.sectionTitle}>{t('bugReports.composer.environment.title')}</Text>
            </View>

            <View style={bugReportComposerStyles.sectionFields}>
                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>{t('bugReports.composer.environment.appVersionLabel')}</Text>
                    <TextInput accessibilityLabel={t('bugReports.composer.environment.appVersionLabel')} value={props.appVersion} onChangeText={props.onAppVersionChange} style={bugReportComposerStyles.input} editable={!props.disabled} />
                </View>

                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>{t('bugReports.composer.environment.platformLabel')}</Text>
                    <TextInput accessibilityLabel={t('bugReports.composer.environment.platformLabel')} value={props.platformValue} onChangeText={props.onPlatformValueChange} style={bugReportComposerStyles.input} editable={!props.disabled} />
                </View>

                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>{t('bugReports.composer.environment.osVersionLabel')}</Text>
                    <TextInput accessibilityLabel={t('bugReports.composer.environment.osVersionLabel')} value={props.osVersion} onChangeText={props.onOsVersionChange} style={bugReportComposerStyles.input} editable={!props.disabled} />
                </View>

                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>{t('bugReports.composer.environment.deviceModelLabel')}</Text>
                    <TextInput accessibilityLabel={t('bugReports.composer.environment.deviceModelLabel')} value={props.deviceModel} onChangeText={props.onDeviceModelChange} style={bugReportComposerStyles.input} editable={!props.disabled} />
                </View>

                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>{t('bugReports.composer.environment.serverUrlLabel')}</Text>
                    <TextInput accessibilityLabel={t('bugReports.composer.environment.serverUrlLabel')}
                        value={props.serverUrl}
                        onChangeText={props.onServerUrlChange}
                        style={bugReportComposerStyles.input}
                        editable={!props.disabled}
                        autoCapitalize="none"
                    />
                </View>

                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>{t('bugReports.composer.environment.serverVersionLabel')}</Text>
                    <TextInput accessibilityLabel={t('bugReports.composer.environment.serverVersionLabel')}
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
                    <Switch accessibilityLabel={t('bugReports.composer.consent.understandTitle')} value={props.acceptedPrivacyNotice} onValueChange={props.onAcceptedPrivacyNoticeChange} />
                </View>
                {props.errorText ? (
                    <Text style={bugReportComposerStyles.errorText}>{props.errorText}</Text>
                ) : null}
            </View>
        </View>
    );
}
