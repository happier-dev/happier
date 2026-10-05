import * as React from 'react';

import type { SetupBlockItem } from '@/components/ui/setupBlocks/SetupBlockGrid';
import type { VoiceBrief } from '@/voice/context/buildVoiceBrief';
import { VoiceServiceMark, type VoiceServiceTile } from '@/voice/settings/panels/VoiceServiceGallery';
import { VOICE_SETUP_STEP_ID } from '@/voice/settings/setup/useVoiceSetupItem';
import { VoiceSetupTile } from '@/voice/settings/setup/VoiceSetupItem';
import { VoiceSetupPanel, type VoiceSetupPanelModel } from '@/voice/settings/setup/VoiceSetupPanel';
import { deriveVoiceSetupFacts } from '@/voice/settings/setup/voiceSetupFacts';
import type { VoiceRoleReadiness } from '@/voice/registry/readiness';
import type { Message } from '@happier-dev/session-core/messages';

/** Lab `voice-moments` frames the fixture draws: SA collapsed, SB choose, SC microphone, SD done. */
export type VoiceSetupFixtureFrame = 'SA' | 'SB' | 'SC' | 'SD';

export function isVoiceSetupFixtureFrame(value: unknown): value is VoiceSetupFixtureFrame {
    return value === 'SA' || value === 'SB' || value === 'SC' || value === 'SD';
}

const NEVER = () => {};

/** Lab B1's brief (dev only): workflow/automation destinations so no session store is read. */
export const LAB_BRIEF: Pick<VoiceBrief, 'items' | 'incomplete' | 'caughtUp'> = {
    incomplete: false,
    caughtUp: false,
    items: [
        { key: 'review', category: 'needs_you', title: 'Review #2481', subtitle: 'Wants to run yarn test:e2e · Studio', destination: { kind: 'workflow', runId: 'dev-review' } },
        { key: 'nightly', category: 'failed', title: 'Nightly release · run 214', subtitle: 'Failed at Publish: npm can’t publish over 0.3.0-preview.14 · 07:12', destination: { kind: 'workflow', runId: 'dev-nightly' } },
        { key: 'relay', category: 'ready', title: 'Relay retry with backoff', subtitle: 'Backoff with jitter, 18 tests pass · devbox', destination: { kind: 'workflow', runId: 'dev-relay' } },
        { key: 'settings', category: 'ready', title: 'Fix settings modal remount', subtitle: 'Keyed by route; 24 tests pass · MacBook Pro', destination: { kind: 'workflow', runId: 'dev-settings' } },
    ],
};

/** Lab data (frame SB's four services, with the marks their presentations declare); dev-only, never shown to a person. */
function labServices(selected: string | null): VoiceServiceTile[] {
    return [
        { id: 'eleven', mark: <VoiceServiceMark identity={{ kind: 'icon', name: 'waveform' }} />, title: 'ElevenLabs', subtitle: 'Through Happier with Happier Pro, or your own ElevenLabs account', status: { tone: 'needs_you', text: 'Needs Happier Pro or a key' } },
        { id: 'openai', mark: <VoiceServiceMark identity={{ kind: 'connected_service', serviceId: 'openai' }} />, title: 'OpenAI Realtime', subtitle: 'Uses your OpenAI account', status: { tone: 'ready', text: 'Account connected' } },
        { id: 'xai', mark: <VoiceServiceMark identity={{ kind: 'agent', agentId: 'grok' }} />, title: 'Grok Voice', subtitle: 'Uses your xAI key', status: { tone: 'needs_you', text: 'Add a key' } },
        { id: 'local', mark: <VoiceServiceMark identity={{ kind: 'icon', name: 'desktop' }} />, title: 'Local voice', subtitle: 'Runs on devbox. Free and private', status: { tone: 'needs_you', text: 'Downloads 1.4 GB' } },
    ].map((tile) => ({ ...tile, selected: tile.id === selected, disabled: false, testID: `dev.voice-setup.service.${tile.id}` } as VoiceServiceTile));
}

const READY: VoiceRoleReadiness = {
    role: 'realtime_conversation', providerId: 'openai', status: 'ready', code: 'ready',
    reasonKey: 'voice.readiness.ready', recoveryAction: 'none',
} as VoiceRoleReadiness;
const TURN_META = { happier: { kind: 'conversation_turn.v1', payload: { v: 1 },
    conversationTurnOriginV1: { v: 1, channel: 'realtime_conversation', modality: 'voice' } } } as const;
const FIRST_TURN = [
    { kind: 'user-text', id: 'dev-input', localId: null, seq: 1, createdAt: 1, text: 'What are my sessions doing?', meta: TURN_META },
    { kind: 'agent-text', id: 'dev-reply', localId: null, seq: 2, createdAt: 2, text: 'Two are working; one needs you.', meta: TURN_META },
] as unknown as Message[];

/** Each frame's facts through m-core's real owner; only the inputs are lab data. */
function fixtureModel(frame: VoiceSetupFixtureFrame): VoiceSetupPanelModel {
    const chosen = frame === 'SC' || frame === 'SD';
    const facts = deriveVoiceSetupFacts({
        providerId: chosen ? 'openai' : null,
        readiness: chosen ? READY : null,
        microphonePermission: frame === 'SD' ? 'granted' : 'unknown',
        messages: frame === 'SD' ? FIRST_TURN : [],
    });
    // SB: the usable service is already highlighted while the step still asks (lab SB).
    const selected = frame === 'SA' ? null : 'openai';
    return {
        facts,
        serviceTitle: chosen ? 'OpenAI Realtime' : null,
        serviceTiles: labServices(selected),
        readiness: null,
        tryLive: false,
        shortcutLabel: frame === 'SD' ? '⌥⌘V' : null,
    };
}

/** The real tile and panel at a lab frame, for `/dev/home?voice=SB` pairing against the lab shots. */
export function buildVoiceSetupFixtureItem(frame: VoiceSetupFixtureFrame, phone: boolean): SetupBlockItem {
    const model = fixtureModel(frame);
    return {
        id: VOICE_SETUP_STEP_ID,
        renderTile: ({ open }) => (
            <VoiceSetupTile layout={phone ? 'row' : 'card'} facts={model.facts} onOpen={open} onDismiss={NEVER} />
        ),
        renderPanel: ({ close }) => (
            <VoiceSetupPanel
                testID="dev.voice-setup"
                model={model}
                actions={{
                    onSelectService: NEVER,
                    onRecover: NEVER,
                    onAllowMicrophone: NEVER,
                    onOpenSystemSettings: null,
                    onTry: NEVER,
                    onDone: close,
                    onOpenSettings: NEVER,
                    onClose: close,
                }}
            />
        ),
    };
}
