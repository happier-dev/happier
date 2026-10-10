import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { Message } from '@happier-dev/session-core/messages';
import type { Metadata } from '@happier-dev/session-core/state';

import { DEFAULT_AGENT_ID } from '@/agents/catalog/catalog';
import type { ComposerSuggestionKindId } from '@/components/autocomplete/composerSuggestionKinds';
import { AgentInput } from '@/components/sessions/agentInput/AgentInput';
import { COMPOSER_CONTENT_HORIZONTAL_INSET } from '@/components/sessions/agentInput/composerContentInset';
import { EmbeddedNewChatWelcome } from '@/components/sessions/shell/embedded/EmbeddedNewChatWelcome';
import {
    EmbeddedSessionPartClaimsScope,
    EmbeddedSessionPartsProvider,
    EmbeddedSessionStandardLayout,
    type EmbeddedSessionPartsValue,
} from '@/components/sessions/shell/embedded/EmbeddedSessionParts';
import {
    narrowEmbeddedComposerInputLock,
    resolveEmbeddedComposerControls,
    type SessionViewEmbeddedPresentation,
} from '@/components/sessions/shell/embedded/embeddedSessionPresentation';
import { TranscriptList } from '@/components/sessions/transcript/TranscriptList';
import { SessionTranscriptSourceProvider, useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import type { SessionTranscriptActions, SessionTranscriptSource } from '@/components/sessions/transcript/source/types';
import { useDemoMessages } from '@/hooks/session/useDemoMessages';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';
import { storage } from '@/sync/domains/state/storage';
import { t } from '@/text';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { buildEmbedSessionPresentation } from '@/embed/embedSessionPresentation';
import { EmbedErrorState } from '@/embed/state/EmbedStateSurface';
import { EmbedRuntimeStateSurface } from '@/embed/state/EmbedRuntimeStateSurface';
import { applyEmbedStyle, createDefaultEmbedStyleDependencies, mergeEmbedStyles } from '@/embed/style/embedStyleTheme';

import {
    EMPTY_EMBED_PREVIEW_CONFIGURATION,
    adoptEmbedPreviewConfiguration,
    type EmbedPreviewConfiguration,
} from './embedPreviewConfiguration';
import { startEmbedPreviewGuest } from './embedPreviewGuest';
import { readEmbedPreviewParams } from './embedPreviewRoute';

const styleDependencies = createDefaultEmbedStyleDependencies((delta, options) => {
    storage.getState().applyLocalSettings(delta, options);
});

/** A sample conversation, not a Session: it offers no suggestion kinds and detects no triggers. */
const PREVIEW_SUGGESTION_KINDS: readonly ComposerSuggestionKindId[] = [];
const noSuggestions = async () => [];
const noop = () => undefined;

/** People can type, approve and deny here; nothing leaves the preview (plan 04 §4.10). */
const PREVIEW_INTERACTION: TranscriptInteraction = Object.freeze({
    canSendMessages: true,
    canApprovePermissions: true,
    canFork: false,
    canOpenFiles: false,
    canPreviewMedia: false,
});
const PREVIEW_ACTIONS: SessionTranscriptActions = Object.freeze({
    respondToPermission: async () => undefined,
    answerUserAction: async () => undefined,
    abort: async () => undefined,
    submitMessage: async () => undefined,
});
// The sample declares its Agent for prompt presentation; it has no machine or live Session.
const PREVIEW_METADATA = Object.freeze({ path: '', host: '', flavor: DEFAULT_AGENT_ID } satisfies Metadata);
const PREVIEW_SOURCE_OPTIONS = Object.freeze({ metadata: PREVIEW_METADATA, interaction: PREVIEW_INTERACTION, actions: PREVIEW_ACTIONS });

/** A fixed conversation that exercises the real rows: bubble, reply, code, tool output, approval. */
function buildPreviewMessages(): Message[] {
    const longOutput = Array.from({ length: 18 }, (_, index) => `lead ${String(index + 1).padStart(2, '0')}  score ${60 + ((index * 7) % 40)}  stage open`).join('\n');
    return [
        { kind: 'user-text', id: 'preview-user-1', localId: null, createdAt: 1, text: t('embed.previewUser') },
        {
            kind: 'tool-call', id: 'preview-tool-1', localId: null, createdAt: 2, children: [],
            tool: { name: 'Bash', state: 'completed', input: { command: 'leads list --open' }, createdAt: 2, startedAt: 2, completedAt: 2, description: null, result: longOutput },
        },
        { kind: 'agent-text', id: 'preview-agent-1', localId: null, createdAt: 3, text: `${t('embed.previewAgent')}\n\n\`\`\`yaml\nscore: 82\nnext_step: book a technical demo\n\`\`\`` },
        { kind: 'user-text', id: 'preview-user-2', localId: null, createdAt: 4, text: t('embed.previewFollowUp') },
        {
            kind: 'tool-call', id: 'preview-tool-2', localId: null, createdAt: 5, children: [],
            tool: {
                name: 'Bash', state: 'running', input: { command: 'leads update-stage acme-robotics qualified' },
                createdAt: 5, startedAt: null, completedAt: null, description: null,
                permission: { id: 'preview-permission', status: 'pending' },
            },
        },
    ];
}

/**
 * The preview's embedded presentation, from the same owner the embed frame uses. The preview holds no
 * credential, so "Change model" arrives from Settings already derived from the draft's grant
 * (`deriveEmbedAccessFromGrantV1().changeModel`, sent as `ui.modelPicker`).
 */
function resolvePreviewPresentation(ui: EmbedPreviewConfiguration['ui'], reconnecting: boolean): SessionViewEmbeddedPresentation {
    return { ...buildEmbedSessionPresentation({ phase: 'ready', self: null, ui, reconnecting }), modelPicker: ui.modelPicker === true };
}

/**
 * `/embed/preview` (plan 04 §4.10, U2c): the Settings live preview. The real embedded parts — the
 * transcript rows over a read-only sample source and the real composer — in the standard embedded
 * arrangement, restyled by the same `configure` messages a host sends, so an edit repaints without
 * remounting. Every interaction is a local no-op: it holds no credential and makes no requests, and
 * it refuses to run inside a page from another origin.
 */
export function EmbedPreviewScreen(): React.ReactElement | null {
    const { theme } = useUnistyles();
    const params = React.useMemo(() => (typeof window === 'undefined' ? null : readEmbedPreviewParams(window.location.search)), []);
    const [refused, setRefused] = React.useState(false);
    const [admitted, setAdmitted] = React.useState(false);
    const [configuration, setConfiguration] = React.useState<EmbedPreviewConfiguration>(EMPTY_EMBED_PREVIEW_CONFIGURATION);
    const messages = React.useMemo(buildPreviewMessages, []);
    const source = useDemoMessages(messages, PREVIEW_SOURCE_OPTIONS);

    React.useEffect(() => {
        if (!params) return undefined;
        setReducedMotionPreferenceOverride(params.reduceMotion);
        return () => setReducedMotionPreferenceOverride(null);
    }, [params]);

    React.useEffect(() => {
        if (!params || typeof window === 'undefined') return undefined;
        const guest = startEmbedPreviewGuest({
            window,
            identity: params.identity,
            // Each configure carries the whole current style; unchanged parts keep their reference.
            onConfigure: (configure) => {
                setConfiguration((current) => adoptEmbedPreviewConfiguration(current, configure));
                setAdmitted(true);
            },
        });
        setRefused(guest.refused);
        setAdmitted(guest.admitted);
        return guest.dispose;
    }, [params]);

    React.useEffect(() => {
        if (!admitted || refused) return;
        fireAndForget(applyEmbedStyle(mergeEmbedStyles(configuration.style), styleDependencies), { tag: 'EmbedPreviewScreen.style' });
    }, [admitted, refused, configuration.style]);

    const reconnecting = params?.reconnecting === true;
    const presentation = React.useMemo(
        () => resolvePreviewPresentation(configuration.ui, reconnecting),
        [configuration.ui, reconnecting],
    );
    const controls = React.useMemo(() => resolveEmbeddedComposerControls(presentation)!, [presentation]);
    // While reconnecting, the input keeps its text and only sending waits, as in an open chat.
    const inputLock = React.useMemo(
        () => narrowEmbeddedComposerInputLock(null, presentation, t('connectionStatus.summary.reconnecting')),
        [presentation],
    );
    const newChat = params?.newChat === true;
    // The composer keeps its own draft, so typing in the preview re-renders only the composer.
    const composer = React.useMemo(() => {
        return newChat ? <EmbedPreviewComposer controls={controls} inputLock={inputLock} /> : (
            <SessionTranscriptSourceProvider source={source}>
                <EmbedPreviewConversationComposer controls={controls} inputLock={inputLock} />
            </SessionTranscriptSourceProvider>
        );
    }, [controls, inputLock, newChat, source]);
    const transcript = React.useMemo(() => (newChat ? null : (
        <SessionTranscriptSourceProvider source={source}>
            <TranscriptList datasetKey="embed-preview" metadata={PREVIEW_METADATA} messages={messages} />
        </SessionTranscriptSourceProvider>
    )), [messages, newChat, source]);
    const parts = React.useMemo<EmbeddedSessionPartsValue>(() => ({
        transcript,
        placeholder: newChat ? <EmbeddedNewChatWelcome /> : null,
        composer,
        state: 'ready',
        chatBottomSpacing: 'none',
    }), [composer, newChat, transcript]);

    if (!params || refused) return <EmbedErrorState code="origin_not_allowed" />;
    if (!admitted) return null;

    return (
        <View style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.background.canvas }} testID="embed-preview">
            {/* The line open chats show while an enforced access edit makes them reconnect (lab D2). */}
            {reconnecting ? <EmbedRuntimeStateSurface phase="error" error="credential_unavailable" retained onRetry={noop} /> : null}
            <EmbeddedSessionPartClaimsScope>
                <EmbeddedSessionPartsProvider value={parts}>
                    <EmbeddedSessionStandardLayout />
                </EmbeddedSessionPartsProvider>
            </EmbeddedSessionPartClaimsScope>
        </View>
    );
}

type EmbedPreviewComposerProps = Readonly<{
    controls: NonNullable<ReturnType<typeof resolveEmbeddedComposerControls>>;
    inputLock: ReturnType<typeof narrowEmbeddedComposerInputLock>;
}>;

function EmbedPreviewConversationComposer(props: EmbedPreviewComposerProps) {
    const source = useSessionTranscriptSource();
    const pending = source.usePendingRequests();
    const interaction = source.useInteraction();
    const metadata = source.useMetadata();
    return <EmbedPreviewComposer {...props} metadata={metadata} attention={{ pending, interaction }} />;
}

function EmbedPreviewComposer(props: EmbedPreviewComposerProps & Readonly<{
    metadata?: Metadata | null;
    attention?: Readonly<{ pending: ReturnType<SessionTranscriptSource['usePendingRequests']>; interaction: TranscriptInteraction }>;
}>) {
    const [draft, setDraft] = React.useState('');
    return (
        <AgentInput
            value={draft}
            onChangeText={setDraft}
            placeholder={t('session.inputPlaceholder')}
            onSend={noop}
            metadata={props.metadata ?? undefined}
            permissionRequests={props.attention?.pending.permissionRequests}
            approvalRequests={props.attention?.pending.approvalRequests}
            canApprovePermissions={props.attention?.interaction.canApprovePermissions}
            permissionDisabledReason={props.attention?.interaction.permissionDisabledReason}
            contentPaddingHorizontal={COMPOSER_CONTENT_HORIZONTAL_INSET}
            agentType={DEFAULT_AGENT_ID}
            modelMode="default"
            onModelModeChange={noop}
            voiceAffordance={props.controls.voiceAffordance}
            engineControls={props.controls.engineControls}
            onAttachmentsAdded={props.controls.attachments ? noop : undefined}
            composerInputLock={props.inputLock}
            autocompleteKinds={PREVIEW_SUGGESTION_KINDS}
            autocompleteSuggestions={noSuggestions}
        />
    );
}
