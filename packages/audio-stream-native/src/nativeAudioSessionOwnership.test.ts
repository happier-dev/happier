import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

function readPackageFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, `${new URL('..', import.meta.url).href}/`), 'utf8');
}

describe('native audio-session ownership', () => {
  it('requires the coordinator to configure native capture instead of self-acquiring a legacy session', () => {
    expect(fileURLToPath(new URL('..', import.meta.url))).toContain('audio-stream-native');

    const iosSource = readPackageFile('ios/HappierAudioStreamNativeModule.swift');
    expect(iosSource).not.toMatch(/legacySessionOwned|ensureLegacyDictationSession/);
    expect(iosSource).toMatch(
      /AsyncFunction\("start"\)[\s\S]*?guard self\.audioSessionConfigured else \{[\s\S]*?audio_session_not_configured/,
    );

    const androidSource = readPackageFile(
      'android/src/main/java/dev/happier/audio/HappierAudioStreamNativeModule.kt',
    );
    expect(androidSource).not.toMatch(/legacySessionOwned|ensureLegacyDictationSession/);
    expect(androidSource).toMatch(
      /AsyncFunction\("start"\)[\s\S]*?captureStartAdmission\.run \{/,
    );
  });

  it('restores the Android communication route and observes route selection changes', () => {
    const androidSource = readPackageFile(
      'android/src/main/java/dev/happier/audio/HappierAudioStreamNativeModule.kt',
    );

    expect(androidSource).toMatch(/AudioSessionPriorState/);
    expect(androidSource).toMatch(/communicationDeviceId/);
    expect(androidSource).toMatch(/setCommunicationDevice/);
    expect(androidSource).toMatch(/clearCommunicationDevice/);
    expect(androidSource).toMatch(/addOnCommunicationDeviceChangedListener/);
    expect(androidSource).toMatch(/removeOnCommunicationDeviceChangedListener/);
  });

  it('degrades preferred AEC activation failures but keeps required AEC fail-closed at the capture owner', () => {
    const iosSource = readPackageFile('ios/HappierAudioStreamNativeModule.swift');
    // The match must stay inside `case .preferred:`. An unbounded `[\s\S]*?` reaches
    // the `aecActive = false` in `case .required:`, so the guard passed even with the
    // preferred degradation deleted.
    expect(iosSource).toMatch(/case \.preferred:(?:(?!case \.)[\s\S])*?aecActive = false/);
    expect(iosSource).toMatch(/case \.required:[\s\S]*?aec_unavailable/);

    const androidSource = readPackageFile(
      'android/src/main/java/dev/happier/audio/HappierAudioStreamNativeModule.kt',
    );
    expect(androidSource).toMatch(/AudioCaptureAecRequest\.PREFERRED/);
    expect(androidSource).toMatch(/AudioCaptureAecRequest\.REQUIRED/);
  });

  it('keeps PCM output inside the existing native engine/session owners', () => {
    const iosSource = readPackageFile('ios/HappierAudioStreamNativeModule.swift');
    expect(iosSource).toMatch(/private var player: AVAudioPlayerNode\?/);
    expect(iosSource).toMatch(/engine\.attach\(player\)/);
    expect(iosSource).toMatch(/AsyncFunction\("startPlayback"\)/);
    expect(iosSource).toMatch(/Function\("enqueuePlayback"\)/);
    expect(iosSource).toMatch(/private var playbackChannels = 0/);
    expect(iosSource).toMatch(/let bytesPerFrame = playbackChannels \* 2/);

    const androidSource = readPackageFile(
      'android/src/main/java/dev/happier/audio/HappierAudioStreamNativeModule.kt',
    );
    expect(androidSource).toMatch(/AudioTrack/);
    expect(androidSource).toMatch(/AsyncFunction\("startPlayback"\)/);
    expect(androidSource).toMatch(/Function\("enqueuePlayback"\)/);
    expect(androidSource).toMatch(/Events\(\s*"audioFrame",\s*"captureTerminal",\s*"playbackDrained"/);
    expect(androidSource).toMatch(/AudioTrack\.WRITE_BLOCKING/);
    expect(androidSource).not.toMatch(/drainedBeforeWrite/);
  });

  it('reports a current PCM playback cursor from the stream-scoped native player', () => {
    const iosSource = readPackageFile('ios/HappierAudioStreamNativeModule.swift');
    expect(iosSource).toMatch(/func playbackCursorMs\(streamId: String, generation: Int\)/);
    expect(iosSource).toMatch(/playerTime\(forNodeTime:/);
    expect(iosSource).toMatch(/Function\("getPlaybackCursorMs"\)/);

    const androidSource = readPackageFile(
      'android/src/main/java/dev/happier/audio/HappierAudioStreamNativeModule.kt',
    );
    // Both matches stay inside their own function. An unbounded `[\s\S]*?` from
    // `playbackCursorMs` reaches the `playbackHeadPosition` read in a later function,
    // so the guard passed even with the hardware head read removed entirely.
    expect(androidSource).toMatch(
      /private fun playbackCursorMs\((?:(?!\n  private fun )[\s\S])*?updatePlaybackProgressLocked\(/,
    );
    expect(androidSource).toMatch(
      /private fun updatePlaybackProgressLocked\((?:(?!\n  private fun )[\s\S])*?\.playbackHeadPosition/,
    );
    expect(androidSource).toMatch(/Function\("getPlaybackCursorMs"\)/);
  });

  it('leaves Android PCM audible at the canonical duck gain without turning it into a capture suspension', () => {
    const androidSource = readPackageFile(
      'android/src/main/java/dev/happier/audio/HappierAudioStreamNativeModule.kt',
    );

    expect(androidSource).toMatch(
      /AudioFocusRequest\.Builder\([\s\S]*?\.setWillPauseWhenDucked\(true\)/,
    );
    expect(androidSource).toMatch(
      /AudioManager\.AUDIOFOCUS_LOSS_TRANSIENT\s*->\s*pauseOutput\(\)[\s\S]*?AudioManager\.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK\s*->\s*AudioPlaybackFocusAction\.NONE/,
    );
    expect(androidSource).toMatch(
      /AudioManager\.AUDIOFOCUS_LOSS_TRANSIENT\s*->\s*\{[\s\S]*?applyPlaybackFocusAction\(playbackFocus\.onFocusChange\(change\)\)[\s\S]*?emitAudioSessionEvent\("focus_changed", mapOf\("state" to "lost_transient"\), generation\)/,
    );
    expect(androidSource).toMatch(
      /AudioManager\.AUDIOFOCUS_GAIN\s*->\s*\{[\s\S]*?applyPlaybackFocusAction\(playbackFocus\.onFocusChange\(change\)\)[\s\S]*?emitAudioSessionEvent\("focus_changed", mapOf\("state" to "gained"\), generation\)/,
    );
    const duckableBranch = androidSource.match(
      /AudioManager\.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK\s*->\s*\{([\s\S]*?)\n\s*\}/,
    )?.[1];
    expect(duckableBranch).toContain('emitAudioSessionEvent("focus_duckable", generation = generation)');
    expect(duckableBranch).not.toContain('applyPlaybackFocusAction');
  });

  it('reconciles each reconfigured Android focus generation to the bridge', () => {
    const androidSource = readPackageFile(
      'android/src/main/java/dev/happier/audio/HappierAudioStreamNativeModule.kt',
    );

    expect(androidSource).toMatch(
      /private fun requestAudioFocus\([\s\S]*?AUDIOFOCUS_REQUEST_GRANTED[\s\S]*?applyPlaybackFocusAction\(playbackFocus\.onFocusRequestGranted\(\)\)[\s\S]*?emitAudioSessionEvent\("focus_changed", mapOf\("state" to "gained"\), generation\)/,
    );
    expect(androidSource).toMatch(
      /if \(output\) \{[\s\S]*?requestAudioFocus\(manager, generation\)[\s\S]*?\} else \{[\s\S]*?playbackFocus\.clear\(\)[\s\S]*?emitAudioSessionEvent\("focus_changed", mapOf\("state" to "not_required"\), generation\)/,
    );
  });
});
