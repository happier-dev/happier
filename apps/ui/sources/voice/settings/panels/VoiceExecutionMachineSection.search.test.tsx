import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { VoiceExecutionMachineSection } from './VoiceExecutionMachineSection';

describe('Voice computer search reveal', () => {
  it('keeps the computer control hidden for ordinary device Dictation', async () => {
    const voice = voiceSettingsParse({ dictation: { sttBinding: 'explicit', stt: { provider: 'device' } } });
    const screen = await renderScreen(
      <DestinationInstanceHost tabId="voice-computer-ordinary" ref={{ kind: 'voiceDictation', params: {} }}
        pathname="/settings/voice/dictation" focused visible>
        <VoiceExecutionMachineSection voice={voice} setVoice={() => {}} intent="dictation" presentation="chip" />
      </DestinationInstanceHost>,
    );
    expect(screen.findByTestId('settings.voice.executionMachine.chip')).toBeNull();
    await screen.unmount();
  });

  it('reveals the declared computer control for device Dictation without requiring a machine', async () => {
    const voice = voiceSettingsParse({ dictation: { sttBinding: 'explicit', stt: { provider: 'device' } } });
    const screen = await renderScreen(
      <DestinationInstanceHost tabId="voice-computer-search" ref={{ kind: 'voiceDictation', params: {
        setting: 'voiceDictation.executionMachine',
      } }} pathname="/settings/voice/dictation" focused visible>
        <VoiceExecutionMachineSection voice={voice} setVoice={() => {}} intent="dictation" presentation="chip" />
      </DestinationInstanceHost>,
    );
    expect(screen.findByTestId('settings.voice.executionMachine.chip')).toBeTruthy();
    expect(screen.findByTestId('setting-reveal.voiceDictation.executionMachine')).toBeTruthy();
    await screen.unmount();
  });
});
