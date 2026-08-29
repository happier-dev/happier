import * as React from 'react';
import { AppState, Dimensions, Platform, Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    getOptionalHappierTerminalNativeModule,
    getTerminalNativeAvailability,
    getTerminalNativeQaCapabilities,
    injectTerminalNativeRendererCrashForQa,
    type TerminalNativeAvailability,
} from '@happier-dev/terminal-native';

import { isDevRouteEnabled } from '@/auth/routing/devRoutePolicy';
import { EmbeddedTerminalPane } from '@/components/terminal/embedded/EmbeddedTerminalPane.native';
import type { EmbeddedTerminalRendererHandle } from '@/components/terminal/embedded/embeddedTerminalRendererHandle';
import type { EmbeddedTerminalPaneController } from '@/components/terminal/embedded/types';
import type { GhosttyRendererSelectionOptions } from '@/components/terminal/ghostty/availability';
import type { TermuxRendererSelectionOptions } from '@/components/terminal/termux/availability';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text, TextInput } from '@/components/ui/text/Text';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';

import { createTerminalQaSession } from './session';
import { createTerminalQaRunIdentity, readTerminalQaBuildIdentity } from './evidenceIdentity';
import { listTerminalQaWorkloads, type TerminalQaWorkloadId } from './workloads';

const QA_SURFACE_KEY = 'terminal-qa-loaded-device';
const QA_TERMINAL_ID = 'terminal-qa:loaded-device';

type TerminalRendererPreference = 'auto' | 'xterm-webview' | 'native';

export function TerminalQaScreen(): React.ReactElement | null {
    if (!isDevRouteEnabled()) return null;
    return <TerminalQaScreenEnabled />;
}

function TerminalQaScreenEnabled(): React.ReactElement {
    const { theme } = useUnistyles();
    const terminalRef = React.useRef<EmbeddedTerminalRendererHandle | null>(null);
    const buildIdentity = React.useMemo(() => readTerminalQaBuildIdentity(), []);
    const runIdentity = React.useMemo(
        () => buildIdentity ? createTerminalQaRunIdentity(buildIdentity) : null,
        [buildIdentity],
    );
    const session = React.useMemo(() => createTerminalQaSession({
        terminalId: QA_TERMINAL_ID,
        rendererRef: terminalRef,
        evidenceIdentity: runIdentity ?? {
            runId: 'missing-build-evidence',
            runNonce: 'missing-build-evidence',
            buildEvidenceId: 'missing-build-evidence',
            sourceStateSha256: 'missing-build-evidence',
            dependencyClosureSha256: 'missing-build-evidence',
        },
    }), [runIdentity]);
    const snapshot = React.useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
    const [terminalRendererPreference, setTerminalRendererPreference] = useLocalSettingMutable('terminalRendererPreference');
    const [nativeQuarantine, setNativeQuarantine] = useLocalSettingMutable('terminalNativeRendererQuarantine');
    const [detectedUrl, setDetectedUrl] = React.useState<EmbeddedTerminalPaneController['detectedUrl']>(null);
    const [pasteText, setPasteText] = React.useState('line one\nline two');
    const qaCapabilities = React.useMemo(() => getTerminalNativeQaCapabilities(), []);
    const nativeRenderer = React.useMemo(
        () => createTerminalQaNativeRendererOptions(Platform.OS, getTerminalNativeAvailability({
            platform: Platform.OS,
            featureEnabled: true,
            accessibilityAccepted: true,
        })),
        [],
    );

    React.useEffect(() => () => session.dispose(), [session]);
    React.useEffect(() => {
        session.notifyLifecycle(`app-state=${AppState.currentState}`);
        const appStateSubscription = AppState.addEventListener('change', (state) => {
            session.notifyLifecycle(`app-state=${state}`);
        });
        const dimensionsSubscription = Dimensions.addEventListener('change', ({ window }) => {
            session.notifyLifecycle(`window=${Math.round(window.width)}x${Math.round(window.height)}`);
        });
        return () => {
            appStateSubscription.remove();
            dimensionsSubscription.remove();
        };
    }, [session]);
    React.useEffect(() => {
        const nativeModule = getOptionalHappierTerminalNativeModule();
        if (!nativeModule?.addListener) return undefined;
        const renderer = Platform.OS === 'android' ? 'android-termux' : 'ios-ghosttykit';
        const surfaceId = `embedded-terminal:${renderer}:${QA_SURFACE_KEY}`;
        const subscription = nativeModule.addListener('selection', (event) => {
            if (event.surfaceId !== surfaceId) return;
            session.notifySelection(event.state, event.text ? new TextEncoder().encode(event.text).byteLength : 0);
        });
        return () => subscription.remove();
    }, [session]);

    const controller = React.useMemo<EmbeddedTerminalPaneController>(() => ({
        status: 'connected',
        error: null,
        detectedUrl,
        onInput: (data) => session.writeInput(data),
        onPaste: (data) => session.writePaste(data),
        onLink: (url) => {
            setDetectedUrl({ url, kind: 'generic' });
            session.notifyLink(url);
        },
        onResize: session.notifyResize,
        onReady: session.notifyRendererReady,
        onWriteComplete: session.onWriteComplete,
        copySelection: (request) => {
            const text = request?.text ?? '';
            session.notifyCopy(new TextEncoder().encode(text).byteLength);
            if (text) void setClipboardStringSafe(text);
        },
        clearTerminal: session.clear,
        requestRestart: () => {
            session.clear();
            session.retry();
        },
        retryConnect: session.retry,
        dismissDetectedUrl: () => setDetectedUrl(null),
    }), [detectedUrl, session]);

    const setPreference = React.useCallback((value: TerminalRendererPreference) => {
        setTerminalRendererPreference(value);
    }, [setTerminalRendererPreference]);

    const injectCrash = React.useCallback(async () => {
        const renderer = Platform.OS === 'android' ? 'android-termux' : 'ios-ghosttykit';
        const surfaceId = `embedded-terminal:${renderer}:${QA_SURFACE_KEY}`;
        const result = await injectTerminalNativeRendererCrashForQa(surfaceId);
        session.notifyCrashInjection(result.injected
            ? `injected surface=${renderer}`
            : `not-injected reason=${result.reason}`);
    }, [session]);

    return (
        <View testID="terminal-qa-root" style={[styles.root, { backgroundColor: theme.colors.surface.base }]}>
            <View style={styles.header}>
                <Text style={[styles.title, { color: theme.colors.text.primary }]}>TERM loaded-device QA</Text>
                <Text style={{ color: theme.colors.text.secondary }}>
                    Internal deterministic renderer validation. Do not enter credentials or secrets.
                </Text>
            </View>

            <View style={styles.pane}>
                <EmbeddedTerminalPane
                    title={`TERM QA - ${Platform.OS}`}
                    controller={controller}
                    terminalRef={terminalRef}
                    nativeRenderer={nativeRenderer}
                    nativeSurfaceKey={QA_SURFACE_KEY}
                    testIdPrefix="terminal-qa-pane"
                    showQuickKeys={true}
                    enableNativeRendererQaCrashControl={true}
                />
            </View>

            <ScrollView style={styles.controls} contentContainerStyle={styles.controlsContent}>
                <Section title="Renderer selection">
                    <Text testID="terminal-qa-renderer-preference" style={{ color: theme.colors.text.secondary }}>
                        Preference: {String(terminalRendererPreference)} / quarantine: {nativeQuarantine ? 'active' : 'none'}
                    </Text>
                    <ButtonRow>
                        {(['native', 'xterm-webview', 'auto'] as const).map((preference) => (
                            <QaButton
                                key={preference}
                                testID={`terminal-qa-preference-${preference}`}
                                title={preference}
                                onPress={() => setPreference(preference)}
                            />
                        ))}
                        <QaButton
                            testID="terminal-qa-clear-quarantine"
                            title="Clear quarantine"
                            onPress={() => setNativeQuarantine(null)}
                        />
                    </ButtonRow>
                    <Text style={{ color: theme.colors.text.secondary }}>
                        This internal route bypasses server rollout discovery only. It never bypasses package, ABI, source-closure, module, accessibility, or crash-fallback gates.
                    </Text>
                </Section>

                <Section title="Deterministic workloads">
                    <ButtonRow>
                        <QaButton
                            testID="terminal-qa-run-required-workloads"
                            title="Run required matrix"
                            onPress={() => requiredWorkloadIds.forEach(session.runWorkload)}
                        />
                        <QaButton
                            testID="terminal-qa-run-all-workloads"
                            title="Run all"
                            onPress={() => listTerminalQaWorkloads().forEach((workload) => session.runWorkload(workload.id))}
                        />
                    </ButtonRow>
                    {listTerminalQaWorkloads().map((workload) => (
                        <Pressable
                            key={workload.id}
                            testID={`terminal-qa-workload-${workload.id}`}
                            accessibilityRole="button"
                            accessibilityLabel={`Run terminal QA workload ${workload.id}`}
                            onPress={() => session.runWorkload(workload.id)}
                            style={[styles.workload, { borderColor: theme.colors.border.default }]}
                        >
                            <Text style={[styles.workloadTitle, { color: theme.colors.text.primary }]}>{workload.id}</Text>
                            <Text style={{ color: theme.colors.text.secondary }}>{workload.byteLength} bytes / {workload.description}</Text>
                        </Pressable>
                    ))}
                </Section>

                <Section title="Input, ACK, fallback, and accessibility">
                    <TextInput
                        testID="terminal-qa-paste-input"
                        value={pasteText}
                        onChangeText={setPasteText}
                        multiline={true}
                        autoCorrect={false}
                        autoCapitalize="none"
                        accessibilityLabel="Terminal QA bracketed paste text"
                        style={[
                            styles.pasteInput,
                            {
                                color: theme.colors.text.primary,
                                backgroundColor: theme.colors.surface.inset,
                                borderColor: theme.colors.border.default,
                            },
                        ]}
                    />
                    <ButtonRow>
                        <QaButton
                            testID="terminal-qa-bracketed-paste"
                            title="Send bracketed paste"
                            onPress={() => session.writePaste(pasteText)}
                        />
                        <QaButton
                            testID="terminal-qa-reject-next-write"
                            title="Reject next write once"
                            onPress={session.rejectOneWrite}
                        />
                        <QaButton
                            testID="terminal-qa-focus"
                            title="Focus terminal"
                            onPress={() => terminalRef.current?.focus?.()}
                        />
                        <QaButton
                            testID="terminal-qa-copy-selection"
                            title="Copy selection"
                            onPress={() => terminalRef.current?.copySelection?.()}
                        />
                        <QaButton
                            testID="terminal-qa-inject-crash"
                            title="Crash native to xterm"
                            disabled={!qaCapabilities.rendererCrashInjection}
                            onPress={() => void injectCrash()}
                        />
                    </ButtonRow>
                    <Text style={{ color: theme.colors.text.secondary }}>
                        For IME and hardware-key validation, focus the terminal and use the platform keyboard. For selection, select rendered text and invoke Copy selection. Inspect the platform accessibility tree and navigate the terminal summary/actions with VoiceOver or TalkBack.
                    </Text>
                </Section>

                <Section title="Live evidence">
                    <View testID="terminal-qa-snapshot" accessible={true} accessibilityLabel="Terminal QA live evidence">
                        <Metric label="logical terminal" value={snapshot.terminalId} />
                        <Metric testID="terminal-qa-run-id" label="run id" value={snapshot.runId} />
                        <Metric testID="terminal-qa-run-nonce" label="run nonce" value={snapshot.runNonce} />
                        <Metric testID="terminal-qa-build-evidence-id" label="build evidence id" value={snapshot.buildEvidenceId} />
                        <Metric testID="terminal-qa-source-state-sha256" label="source state sha256" value={snapshot.sourceStateSha256} />
                        <Metric testID="terminal-qa-dependency-closure-sha256" label="dependency closure sha256" value={snapshot.dependencyClosureSha256} />
                        <Metric label="run started at" value={snapshot.runStartedAt} />
                        <Metric testID="terminal-qa-accepted-byte-offset" label="accepted byte offset" value={String(snapshot.acceptedByteOffset)} />
                        <Metric label="queue / in flight" value={`${snapshot.queuedFrames} / ${snapshot.inFlight ? 'yes' : 'no'}`} />
                        <Metric label="write attempts / ACKs / rejects" value={`${snapshot.writeAttempts} / ${snapshot.acknowledgedWrites} / ${snapshot.rejectedWrites}`} />
                        <Metric label="renderer ready / grid" value={`${snapshot.rendererReady ? 'yes' : 'no'} / ${snapshot.cols ?? '?'}x${snapshot.rows ?? '?'}`} />
                        <Metric label="last workload" value={snapshot.lastWorkloadId ?? 'none'} />
                    </View>
                    {snapshot.events.slice().reverse().map((event) => (
                        <Text key={event.id} testID={`terminal-qa-event-${event.id}`} style={[styles.event, { color: theme.colors.text.secondary }]}>
                            {event.kind}: {event.detail}
                        </Text>
                    ))}
                </Section>
            </ScrollView>
        </View>
    );
}

const requiredWorkloadIds: readonly TerminalQaWorkloadId[] = [
    'ansi-burst',
    'heavy-tui-redraw',
    'alternate-screen',
    'wide-combining',
    'long-scrollback',
    'link-heavy-output',
    'bracketed-paste-echo',
];

export function createTerminalQaNativeRendererOptions(
    platform: string,
    availability: TerminalNativeAvailability,
): GhosttyRendererSelectionOptions | TermuxRendererSelectionOptions | undefined {
    if (platform === 'ios') {
        return {
            featureEnabled: true,
            platform,
            availability,
            packageProofAccepted: availability.available,
            crashFallbackAvailable: true,
        };
    }
    if (platform === 'android') {
        return {
            featureEnabled: true,
            platform,
            availability,
            packageProofAccepted: availability.available,
            crashFallbackAvailable: true,
        };
    }
    return undefined;
}

function Section(props: Readonly<{ title: string; children: React.ReactNode }>) {
    const { theme } = useUnistyles();
    return (
        <View style={[styles.section, { borderColor: theme.colors.border.default }]}>
            <Text style={[styles.sectionTitle, { color: theme.colors.text.primary }]}>{props.title}</Text>
            {props.children}
        </View>
    );
}

function ButtonRow(props: Readonly<{ children: React.ReactNode }>) {
    return <View style={styles.buttonRow}>{props.children}</View>;
}

function QaButton(props: Readonly<{
    title: string;
    testID: string;
    disabled?: boolean;
    onPress: () => void;
}>) {
    return (
        <RoundButton
            size="small"
            display="inverted"
            title={props.title}
            testID={props.testID}
            accessibilityLabel={props.title}
            disabled={props.disabled}
            onPress={props.onPress}
            style={styles.button}
        />
    );
}

function Metric(props: Readonly<{ label: string; value: string; testID?: string }>) {
    const { theme } = useUnistyles();
    return (
        <Text testID={props.testID} style={{ color: theme.colors.text.primary }}>
            {props.label}: {props.value}
        </Text>
    );
}

const styles = StyleSheet.create(() => ({
    root: { flex: 1, minHeight: 0 },
    header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, gap: 4 },
    title: { fontSize: 22, fontWeight: '700' },
    pane: { minHeight: 330, flex: 1 },
    controls: { flex: 1, minHeight: 220 },
    controlsContent: { padding: 12, gap: 12, paddingBottom: 40 },
    section: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12, gap: 10 },
    sectionTitle: { fontSize: 17, fontWeight: '700' },
    buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    button: { minHeight: 36 },
    workload: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 10, gap: 3 },
    workloadTitle: { fontWeight: '700' },
    pasteInput: { minHeight: 72, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 10 },
    event: { fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: undefined }), fontSize: 12 },
}));

export default TerminalQaScreen;
