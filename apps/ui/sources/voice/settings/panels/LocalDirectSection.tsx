import * as React from 'react';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Switch } from '@/components/ui/forms/Switch';
import { Modal } from '@/modal';
import {
  readLocalDirectVoiceSettings,
  voiceSettingsParse,
  writeLocalDirectVoiceSettings,
  type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import { t } from '@/text';
import { parseLocalVoiceSttSettings } from '@/voice/local/localVoiceSettings';
import { LocalVoiceTtsGroup } from '@/voice/settings/panels/localTts/LocalVoiceTtsGroup';
import { LocalVoiceSttGroup } from '@/voice/settings/panels/localStt/LocalVoiceSttGroup';
import { resolveVoiceProviderIdFromSettings } from '@/voice/settings/resolveVoiceProviderId';
import { fireAndForget } from '@/utils/system/fireAndForget';
import type { VoiceDaemonRouteDiagnosticReason } from '@/voice/settings/voiceProviderLocalAvailability';

export function LocalDirectSection(props: {
  voice: VoiceSettings;
  setVoice: (next: VoiceSettings) => void;
  popoverBoundaryRef?: React.RefObject<any> | null;
  daemonRouteDiagnosticReason?: VoiceDaemonRouteDiagnosticReason | null;
}) {
  const voice = voiceSettingsParse(props.voice);
  const enabled = resolveVoiceProviderIdFromSettings(voice) === 'local_direct';
  if (!enabled) return null;

  const cfg = readLocalDirectVoiceSettings(voice);

  const setCfg = (patch: Partial<typeof cfg>) => {
    props.setVoice(writeLocalDirectVoiceSettings(voice, { ...cfg, ...patch }));
  };

  const sttProvider = parseLocalVoiceSttSettings(cfg.stt).provider;

  return (
    <>
      <LocalVoiceSttGroup
        cfgStt={cfg.stt}
        setStt={(next) => setCfg({ stt: next })}
        voice={voice}
        setVoice={props.setVoice}
        popoverBoundaryRef={props.popoverBoundaryRef}
        daemonRouteDiagnosticReason={props.daemonRouteDiagnosticReason}
      />

      {sttProvider === 'device' ? (
        <ItemGroup title={t('settingsVoice.local.conversation.handsFree.title')}>
          <Item
            title={t('settingsVoice.local.conversation.handsFree.enableTitle')}
            rightElement={
              <Switch
                accessibilityLabel={t('settingsVoice.local.conversation.handsFree.enableTitle')}
                value={cfg.handsFree.enabled}
                onValueChange={(v) => setCfg({ handsFree: { ...cfg.handsFree, enabled: v } })}
              />
            }
          />
          <Item
            title={t('settingsVoice.local.conversation.handsFree.silenceTitle')}
            detail={String(cfg.handsFree.endpointing.silenceMs)}
            onPress={() => {
              fireAndForget((async () => {
                const raw = await Modal.prompt(t('settingsVoice.local.conversation.handsFree.silenceTitle'), undefined, {
                  inputType: 'numeric',
                  placeholder: String(cfg.handsFree.endpointing.silenceMs),
                });
                if (raw === null) return;
                const next = Number(String(raw).trim());
                if (!Number.isFinite(next)) return;
                setCfg({
                  handsFree: {
                    ...cfg.handsFree,
                    endpointing: { ...cfg.handsFree.endpointing, silenceMs: Math.max(0, Math.min(5000, Math.floor(next))) },
                  },
                });
              })(), { tag: 'LocalDirectSection.prompt.silenceMs' });
            }}
          />
          <Item
            title={t('settingsVoice.local.conversation.handsFree.minSpeechTitle')}
            detail={String(cfg.handsFree.endpointing.minSpeechMs)}
            onPress={() => {
              fireAndForget((async () => {
                const raw = await Modal.prompt(t('settingsVoice.local.conversation.handsFree.minSpeechTitle'), undefined, {
                  inputType: 'numeric',
                  placeholder: String(cfg.handsFree.endpointing.minSpeechMs),
                });
                if (raw === null) return;
                const next = Number(String(raw).trim());
                if (!Number.isFinite(next)) return;
                setCfg({
                  handsFree: {
                    ...cfg.handsFree,
                    endpointing: { ...cfg.handsFree.endpointing, minSpeechMs: Math.max(0, Math.min(5000, Math.floor(next))) },
                  },
                });
              })(), { tag: 'LocalDirectSection.prompt.minSpeechMs' });
            }}
          />
        </ItemGroup>
      ) : null}

      <LocalVoiceTtsGroup
        cfgTts={cfg.tts}
        setTts={(next) => setCfg({ tts: next })}
        voice={voice}
        setVoice={props.setVoice}
        networkTimeoutMs={cfg.networkTimeoutMs}
        popoverBoundaryRef={props.popoverBoundaryRef}
        daemonRouteDiagnosticReason={props.daemonRouteDiagnosticReason}
      />

      <ItemGroup>
        <Item
          title={t('settingsVoice.local.conversation.network.timeoutTitle')}
          detail={String(cfg.networkTimeoutMs)}
          onPress={() => {
            fireAndForget((async () => {
              const raw = await Modal.prompt(
                t('settingsVoice.local.conversation.network.timeoutTitle'),
                t('settingsVoice.local.conversation.network.timeoutPromptBody'),
                {
                inputType: 'numeric',
                placeholder: String(cfg.networkTimeoutMs),
                }
              );
              if (raw === null) return;
              const next = Number(String(raw).trim());
              if (!Number.isFinite(next)) return;
              setCfg({ networkTimeoutMs: Math.max(1000, Math.min(60000, Math.floor(next))) });
            })(), { tag: 'LocalDirectSection.prompt.networkTimeoutMs' });
          }}
        />
      </ItemGroup>
    </>
  );
}
