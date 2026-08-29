import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve(import.meta.dirname, '..');
const moduleSource = fs.readFileSync(
  path.join(packageRoot, 'android/src/main/java/dev/happier/audio/HappierAudioStreamNativeModule.kt'),
  'utf8',
);
const serviceSource = fs.readFileSync(
  path.join(packageRoot, 'android/src/main/java/dev/happier/audio/HappierVoiceAudioForegroundService.kt'),
  'utf8',
);
const androidResourcesRoot = path.join(packageRoot, 'android/src/main/res');
const localizedResourceDirectories = [
  'values-ca',
  'values-de',
  'values-es',
  'values-fr',
  'values-it',
  'values-ja',
  'values-pl',
  'values-pt',
  'values-ru',
  'values-zh-rCN',
  'values-zh-rTW',
];

describe('Android Voice audio reliability contract', () => {
  it('degrades only preferred AEC activation failures and keeps required AEC fail-closed', () => {
    expect(moduleSource).toMatch(
      /AudioCaptureAecRequest\.PREFERRED\s*->\s*try\s*\{[\s\S]*?activateAec\(\)[\s\S]*?catch \(_: Throwable\)[\s\S]*?false/,
    );
    expect(moduleSource).toMatch(
      /AudioCaptureAecRequest\.REQUIRED\s*->\s*try\s*\{[\s\S]*?activateAec\(\)[\s\S]*?throw IllegalStateException\("aec_unavailable", error\)/,
    );
    expect(moduleSource).toContain('Noise suppression is not part of the required-AEC admission contract.');
    expect(moduleSource).toMatch(
      /val aec = activeAec[\s\S]*?activeAec = null[\s\S]*?activeStreamId = null[\s\S]*?try \{\s*aec\?\.release\(\)[\s\S]*?try \{\s*noiseSuppressor\?\.release\(\)/,
    );
  });

  it('marks foreground delivery active only after the exact service start is acknowledged', () => {
    expect(moduleSource).toMatch(
      /HappierVoiceAudioForegroundService\.start\(context, requestId\)[\s\S]*?if \(foregroundServiceStartRequestId != requestId\) return@synchronized[\s\S]*?if \(result\.isSuccess\) \{[\s\S]*?voiceForegroundServiceActive = true/,
    );
    expect(moduleSource).not.toMatch(
      /HappierVoiceAudioForegroundService\.start\([^\n]*\)\s*\n\s*voiceForegroundServiceActive = true/,
    );
    expect(moduleSource).toContain('HappierVoiceAudioForegroundService.cancelPendingStart(requestId)');
  });

  it('acknowledges only after startForeground and reports exact start failure', () => {
    const startForegroundIndex = serviceSource.indexOf('startForeground(');
    const successIndex = serviceSource.indexOf('settleStart(requestId, Result.success(Unit))');
    expect(startForegroundIndex).toBeGreaterThan(-1);
    expect(successIndex).toBeGreaterThan(startForegroundIndex);
    expect(serviceSource).toContain('settleStart(requestId, Result.failure(error))');
    expect(serviceSource).toContain('if (pendingStart?.first == requestId) pendingStart = null');
  });

  it('makes the persistent Voice notification reopen Happier', () => {
    expect(serviceSource).toContain('packageManager.getLaunchIntentForPackage(packageName)');
    expect(serviceSource).toContain('PendingIntent.getActivity');
    expect(serviceSource).toContain('notificationBuilder.setContentIntent(contentIntent)');
  });

  it('ships localized build-owned foreground notification resources', () => {
    for (const directory of localizedResourceDirectories) {
      const resource = fs.readFileSync(
        path.join(androidResourcesRoot, directory, 'strings.xml'),
        'utf8',
      );
      expect(resource).toContain('name="happier_voice_foreground_notification_channel"');
      expect(resource).toContain('name="happier_voice_foreground_notification_text"');
    }
  });
});
