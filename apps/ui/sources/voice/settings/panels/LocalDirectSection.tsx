import * as React from 'react';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Switch } from '@/components/ui/forms/Switch';
import { Modal } from '@/modal';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { t } from '@/text';
import { LocalVoiceTtsGroup } from '@/voice/settings/panels/localTts/LocalVoiceTtsGroup';
import { LocalVoiceSttGroup } from '@/voice/settings/panels/localStt/LocalVoiceSttGroup';

export function LocalDirectSection(props: {
  voice: VoiceSettings;
  setVoice: (next: VoiceSettings) => void;
  popoverBoundaryRef?: React.RefObject<any> | null;
}) {
  const enabled = props.voice.providerId === 'local_direct';
  if (!enabled) return null;

  const cfg = props.voice.adapters.local_direct;

  const setCfg = (patch: Partial<typeof cfg>) => {
    props.setVoice({
      ...props.voice,
      adapters: {
        ...props.voice.adapters,
        local_direct: { ...cfg, ...patch },
      },
    });
  };

  const sttProvider =
    typeof (cfg.stt as any)?.provider === 'string'
      ? ((cfg.stt as any).provider as any)
      : (cfg.stt as any)?.useDeviceStt === true
        ? 'device'
        : 'openai_compat';

  return (
    <>
      <LocalVoiceSttGroup cfgStt={cfg.stt} setStt={(next) => setCfg({ stt: next })} popoverBoundaryRef={props.popoverBoundaryRef} />

      {sttProvider === 'device' ? (
        <ItemGroup title="Hands-free">
          <Item
            title="Enable hands-free"
            rightElement={
              <Switch
                value={cfg.handsFree.enabled}
                onValueChange={(v) => setCfg({ handsFree: { ...cfg.handsFree, enabled: v } })}
              />
            }
          />
          <Item
            title="Silence (ms)"
            detail={String(cfg.handsFree.endpointing.silenceMs)}
            onPress={() => {
              void (async () => {
                const raw = await Modal.prompt('Silence (ms)', undefined, {
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
              })();
            }}
          />
          <Item
            title="Minimum speech (ms)"
            detail={String(cfg.handsFree.endpointing.minSpeechMs)}
            onPress={() => {
              void (async () => {
                const raw = await Modal.prompt('Minimum speech (ms)', undefined, {
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
              })();
            }}
          />
        </ItemGroup>
      ) : null}

      <LocalVoiceTtsGroup
        cfgTts={cfg.tts}
        setTts={(next) => setCfg({ tts: next })}
        networkTimeoutMs={cfg.networkTimeoutMs}
        popoverBoundaryRef={props.popoverBoundaryRef}
      />

      <ItemGroup>
        <Item
          title="Network timeout (ms)"
          detail={String(cfg.networkTimeoutMs)}
          onPress={() => {
            void (async () => {
              const raw = await Modal.prompt('Network timeout (ms)', 'Timeout for requests to your STT/TTS endpoints (1000–60000).', {
                inputType: 'numeric',
                placeholder: String(cfg.networkTimeoutMs),
              });
              if (raw === null) return;
              const next = Number(String(raw).trim());
              if (!Number.isFinite(next)) return;
              setCfg({ networkTimeoutMs: Math.max(1000, Math.min(60000, Math.floor(next))) });
            })();
          }}
        />
      </ItemGroup>
    </>
  );
}
