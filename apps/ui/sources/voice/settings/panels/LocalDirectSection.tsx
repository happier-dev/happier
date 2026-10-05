import * as React from 'react';

import {
  readLocalDirectVoiceSettings,
  voiceSettingsParse,
  writeLocalDirectVoiceSettings,
  type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import { parseLocalVoiceTtsSettings } from '@/voice/local/localVoiceSettings';
import { LocalVoiceTtsGroup } from '@/voice/settings/panels/localTts/LocalVoiceTtsGroup';
import { LocalVoiceSttGroup } from '@/voice/settings/panels/localStt/LocalVoiceSttGroup';
import { VoiceHearControls } from '@/voice/settings/panels/VoiceHearControls';
import { resolveVoiceSttCapturePlan } from '@/voice/runtime/input/resolveVoiceSttCapturePlan';
import { resolveVoiceProviderIdFromSettings } from '@/voice/settings/resolveVoiceProviderId';
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


  return (
    <>
      <LocalVoiceSttGroup
        cfgStt={cfg.stt}
        setStt={(next) => setCfg({ stt: next })}
        voice={voice}
        setVoice={props.setVoice}
        popoverBoundaryRef={props.popoverBoundaryRef}
        daemonRouteDiagnosticReason={props.daemonRouteDiagnosticReason}
      >
        <VoiceHearControls
          handsFree={cfg.handsFree}
          handsFreeSupported={resolveVoiceSttCapturePlan({ voice }).provider !== 'recorded_audio'}
          setHandsFree={(handsFree) => setCfg({ handsFree })}
          bargeInEnabled={parseLocalVoiceTtsSettings(cfg.tts).bargeInEnabled}
          setBargeInEnabled={(bargeInEnabled) => setCfg({ tts: { ...parseLocalVoiceTtsSettings(cfg.tts), bargeInEnabled } })}
          testIDPrefix="settings.voice.localDirect"
        />
      </LocalVoiceSttGroup>


      <LocalVoiceTtsGroup
        cfgTts={cfg.tts}
        setTts={(next) => setCfg({ tts: next })}
        voice={voice}
        setVoice={props.setVoice}
        networkTimeoutMs={cfg.networkTimeoutMs}
        popoverBoundaryRef={props.popoverBoundaryRef}
        daemonRouteDiagnosticReason={props.daemonRouteDiagnosticReason}
      />

    </>
  );
}
