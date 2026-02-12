import React from 'react';
import { Pressable, TextInput, View } from 'react-native';

import { Switch } from '@/components/ui/forms/Switch';
import { Text } from '@/components/ui/text/StyledText';

import { type BugReportDeploymentType, type BugReportFrequency, type BugReportSeverity } from './bugReportFallback';
import { BugReportChoiceRow } from './BugReportChoiceRow';
import { bugReportComposerStyles } from './bugReportComposerStyles';

type BugReportDiagnosticsKind = 'ui-mobile' | 'daemon' | 'server' | 'stack-service';

const DIAGNOSTICS_KIND_OPTIONS: Array<{
    kind: BugReportDiagnosticsKind;
    title: string;
    detail: string;
}> = [
    {
        kind: 'ui-mobile',
        title: 'App diagnostics',
        detail: 'App console logs, recent user actions, and session summary.',
    },
    {
        kind: 'daemon',
        title: 'Daemon diagnostics',
        detail: 'Daemon summary and recent daemon logs from selected machines.',
    },
    {
        kind: 'stack-service',
        title: 'Stack service diagnostics',
        detail: 'Stack context and recent stack logs (if available).',
    },
    {
        kind: 'server',
        title: 'Server diagnostics',
        detail: 'Server snapshot from the currently active server.',
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
                <Text style={bugReportComposerStyles.sectionTitle}>Diagnostics</Text>
                <Text style={bugReportComposerStyles.helperText}>Choose what to include and preview before submitting.</Text>
            </View>

            <View style={bugReportComposerStyles.toggleRows}>
                <View style={bugReportComposerStyles.toggleRow}>
                    <View style={{ flex: 1, gap: 4 }}>
                        <Text style={bugReportComposerStyles.label}>Include diagnostics</Text>
                        <Text style={bugReportComposerStyles.helperText}>Attach sanitized debugging artifacts for faster diagnosis.</Text>
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
                                        <Text style={bugReportComposerStyles.label}>{option.title}</Text>
                                        <Text style={bugReportComposerStyles.helperText}>
                                            {option.detail}{allowed ? '' : ' (disabled by server)'}
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

                        <Pressable
                            style={[bugReportComposerStyles.previewButton, props.previewDisabled && bugReportComposerStyles.previewButtonDisabled]}
                            onPress={props.onPreviewDiagnostics}
                            disabled={props.previewDisabled}
                            accessibilityRole="button"
                            accessibilityLabel="Preview diagnostics"
                        >
                            <Text style={bugReportComposerStyles.previewButtonText}>Preview diagnostics</Text>
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
    disabled: boolean;
}>): React.JSX.Element {
    return (
        <View style={bugReportComposerStyles.section}>
            <View style={bugReportComposerStyles.sectionHeader}>
                <Text style={bugReportComposerStyles.sectionTitle}>Describe the issue</Text>
                <Text style={bugReportComposerStyles.helperText}>Provide enough detail so we can reproduce and diagnose quickly.</Text>
            </View>

            <View style={bugReportComposerStyles.sectionFields}>
                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>Title</Text>
                    <TextInput
                        value={props.title}
                        onChangeText={props.onTitleChange}
                        placeholder="Short issue title"
                        placeholderTextColor={props.placeholderTextColor}
                        style={bugReportComposerStyles.input}
                        editable={!props.disabled}
                        maxLength={200}
                    />
                </View>

                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>GitHub username (optional)</Text>
                    <TextInput
                        value={props.reporterGithubUsername}
                        onChangeText={props.onReporterGithubUsernameChange}
                        placeholder="Used as contact info in the issue body"
                        placeholderTextColor={props.placeholderTextColor}
                        style={bugReportComposerStyles.input}
                        editable={!props.disabled}
                        autoCapitalize="none"
                        autoCorrect={false}
                        maxLength={80}
                    />
                </View>

                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>Concise summary</Text>
                    <TextInput
                        value={props.summary}
                        onChangeText={props.onSummaryChange}
                        placeholder="One-paragraph summary"
                        placeholderTextColor={props.placeholderTextColor}
                        style={[bugReportComposerStyles.input, bugReportComposerStyles.textArea]}
                        editable={!props.disabled}
                        multiline
                        numberOfLines={4}
                        maxLength={800}
                    />
                </View>

                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>Current behavior</Text>
                    <TextInput
                        value={props.currentBehavior}
                        onChangeText={props.onCurrentBehaviorChange}
                        placeholder="What actually happens?"
                        placeholderTextColor={props.placeholderTextColor}
                        style={[bugReportComposerStyles.input, bugReportComposerStyles.textArea]}
                        editable={!props.disabled}
                        multiline
                        numberOfLines={4}
                        maxLength={5000}
                    />
                </View>

                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>Expected behavior</Text>
                    <TextInput
                        value={props.expectedBehavior}
                        onChangeText={props.onExpectedBehaviorChange}
                        placeholder="What should happen instead?"
                        placeholderTextColor={props.placeholderTextColor}
                        style={[bugReportComposerStyles.input, bugReportComposerStyles.textArea]}
                        editable={!props.disabled}
                        multiline
                        numberOfLines={4}
                        maxLength={5000}
                    />
                </View>

                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>Reproduction steps</Text>
                    <TextInput
                        value={props.reproductionStepsText}
                        onChangeText={props.onReproductionStepsTextChange}
                        placeholder={'1. Open Happier\n2. Start a session\n3. ...'}
                        placeholderTextColor={props.placeholderTextColor}
                        style={[bugReportComposerStyles.input, bugReportComposerStyles.textArea]}
                        editable={!props.disabled}
                        multiline
                        numberOfLines={5}
                        maxLength={4000}
                    />
                </View>

                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>What changed recently (optional)</Text>
                    <TextInput
                        value={props.whatChangedRecently}
                        onChangeText={props.onWhatChangedRecentlyChange}
                        placeholder="Updates, config changes, new setup steps..."
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
                <Text style={bugReportComposerStyles.sectionTitle}>Frequency and severity</Text>
            </View>

            <View style={bugReportComposerStyles.sectionFields}>
                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>Frequency</Text>
                    <BugReportChoiceRow
                        value={props.frequency}
                        onChange={props.onFrequencyChange}
                        options={[
                            { value: 'always', label: 'Always' },
                            { value: 'often', label: 'Often' },
                            { value: 'sometimes', label: 'Sometimes' },
                            { value: 'once', label: 'Once' },
                        ]}
                    />
                </View>

                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>Severity</Text>
                    <BugReportChoiceRow
                        value={props.severity}
                        onChange={props.onSeverityChange}
                        options={[
                            { value: 'blocker', label: 'Blocker' },
                            { value: 'high', label: 'High' },
                            { value: 'medium', label: 'Medium' },
                            { value: 'low', label: 'Low' },
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
                <Text style={bugReportComposerStyles.sectionTitle}>Environment (editable)</Text>
            </View>

            <View style={bugReportComposerStyles.sectionFields}>
                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>App version</Text>
                    <TextInput value={props.appVersion} onChangeText={props.onAppVersionChange} style={bugReportComposerStyles.input} editable={!props.disabled} />
                </View>

                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>Platform</Text>
                    <TextInput value={props.platformValue} onChangeText={props.onPlatformValueChange} style={bugReportComposerStyles.input} editable={!props.disabled} />
                </View>

                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>OS version</Text>
                    <TextInput value={props.osVersion} onChangeText={props.onOsVersionChange} style={bugReportComposerStyles.input} editable={!props.disabled} />
                </View>

                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>Device model</Text>
                    <TextInput value={props.deviceModel} onChangeText={props.onDeviceModelChange} style={bugReportComposerStyles.input} editable={!props.disabled} />
                </View>

                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>Server URL</Text>
                    <TextInput
                        value={props.serverUrl}
                        onChangeText={props.onServerUrlChange}
                        style={bugReportComposerStyles.input}
                        editable={!props.disabled}
                        autoCapitalize="none"
                    />
                </View>

                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>Server version (optional)</Text>
                    <TextInput
                        value={props.serverVersion}
                        onChangeText={props.onServerVersionChange}
                        style={bugReportComposerStyles.input}
                        editable={!props.disabled}
                    />
                </View>

                <View style={bugReportComposerStyles.field}>
                    <Text style={bugReportComposerStyles.label}>Deployment type</Text>
                    <BugReportChoiceRow
                        value={props.deploymentType}
                        onChange={props.onDeploymentTypeChange}
                        options={[
                            { value: 'cloud', label: 'Cloud' },
                            { value: 'self-hosted', label: 'Self-hosted' },
                            { value: 'enterprise', label: 'Enterprise' },
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
}>): React.JSX.Element {
    return (
        <View style={bugReportComposerStyles.section}>
            <View style={bugReportComposerStyles.sectionHeader}>
                <Text style={bugReportComposerStyles.sectionTitle}>Consent</Text>
            </View>

            <View style={bugReportComposerStyles.toggleRows}>
                <View style={bugReportComposerStyles.toggleRow}>
                    <View style={{ flex: 1, gap: 4 }}>
                        <Text style={bugReportComposerStyles.label}>I understand diagnostics may include technical metadata</Text>
                        <Text style={bugReportComposerStyles.helperText}>Do not include passwords, access tokens, or private keys.</Text>
                    </View>
                    <Switch value={props.acceptedPrivacyNotice} onValueChange={props.onAcceptedPrivacyNoticeChange} />
                </View>
            </View>
        </View>
    );
}
