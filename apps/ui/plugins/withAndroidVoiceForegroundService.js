const { withAndroidManifest } = require('expo/config-plugins');

const VOICE_FOREGROUND_SERVICE = 'dev.happier.audio.HappierVoiceAudioForegroundService';
const VOICE_FOREGROUND_SERVICE_PERMISSIONS = [
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
];

/**
 * Declares the platform-owned service that the aggregate native Voice audio
 * session starts while a conversation retains microphone capture in background.
 */
function withAndroidVoiceForegroundService(config) {
  return withAndroidManifest(config, (manifestConfig) => {
    const manifest = manifestConfig.modResults.manifest;
    const permissions = manifest['uses-permission'] ?? [];
    manifest['uses-permission'] = permissions;
    for (const permission of VOICE_FOREGROUND_SERVICE_PERMISSIONS) {
      if (permissions.some((entry) => entry.$?.['android:name'] === permission)) continue;
      permissions.push({ $: { 'android:name': permission } });
    }

    const applications = manifest.application ?? [];
    manifest.application = applications;
    if (applications.length === 0) applications.push({ $: {} });
    const application = applications[0];
    const services = application.service ?? [];
    application.service = services;
    const service = services.find((entry) => entry.$?.['android:name'] === VOICE_FOREGROUND_SERVICE);
    const attributes = {
      'android:name': VOICE_FOREGROUND_SERVICE,
      'android:exported': 'false',
      'android:foregroundServiceType': 'microphone|mediaPlayback',
    };
    if (service) {
      service.$ = { ...service.$, ...attributes };
    } else {
      services.push({ $: attributes });
    }

    return manifestConfig;
  });
}

module.exports = withAndroidVoiceForegroundService;
