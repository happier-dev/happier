import { sync } from '@/sync/sync';
import { speakDeviceText, stopDeviceSpeech } from '@/voice/local/speakDeviceText';
import { speakGoogleCloudText } from '@/voice/output/GoogleCloudTtsController';
import { speakKokoroText } from '@/voice/output/KokoroTtsController';
import { speakOpenAiCompatText } from '@/voice/output/TtsController';
import type { VoiceLocalTtsSettings } from '@/sync/domains/settings/voiceLocalTtsSettings';
import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/VoicePlaybackController';

export async function speakWithLocalTtsProvider(ctx: {
  text: string;
  settings: any;
  tts: VoiceLocalTtsSettings;
  networkTimeoutMs: number;
  registerPlaybackStopper: VoicePlaybackStopperRegistrar;
  onSpeaking: () => void;
}): Promise<void> {
  const provider = ctx.tts.provider;

  if (provider === 'device') {
    let clearStopper = () => {};
    try {
      clearStopper = ctx.registerPlaybackStopper(() => stopDeviceSpeech());
      await speakDeviceText(ctx.text, ctx.onSpeaking).catch(() => {});
    } finally {
      clearStopper();
    }
    return;
  }

  if (provider === 'local_neural') {
    const localNeural = (ctx.tts.localNeural ?? null) as any;
    const model = typeof localNeural?.model === 'string' && localNeural.model.trim() ? localNeural.model.trim() : 'kokoro';
    if (model !== 'kokoro') return;

    const assetSetId = typeof localNeural?.assetId === 'string' && localNeural.assetId.trim() ? localNeural.assetId.trim() : null;
    const voiceId = typeof localNeural?.voiceId === 'string' && localNeural.voiceId.trim() ? localNeural.voiceId.trim() : 'af_heart';
    const speed = typeof localNeural?.speed === 'number' && Number.isFinite(localNeural.speed) ? localNeural.speed : 1;

    ctx.onSpeaking();
    const ok = await speakKokoroText({
      text: ctx.text,
      assetSetId,
      voiceId,
      speed,
      timeoutMs: ctx.networkTimeoutMs,
      registerPlaybackStopper: ctx.registerPlaybackStopper,
    })
      .then(() => true)
      .catch(() => false);

    if (ok) return;

    let clearStopper = () => {};
    try {
      clearStopper = ctx.registerPlaybackStopper(() => stopDeviceSpeech());
      await speakDeviceText(ctx.text, ctx.onSpeaking).catch(() => {});
    } finally {
      clearStopper();
    }
    return;
  }

  if (provider === 'google_cloud') {
    const googleCloud = (ctx.tts.googleCloud ?? null) as any;
    const apiKey = googleCloud?.apiKey ? (sync.decryptSecretValue(googleCloud.apiKey) ?? null) : null;
    if (!apiKey) return;

    const voiceName = typeof googleCloud?.voiceName === 'string' && googleCloud.voiceName.trim() ? googleCloud.voiceName.trim() : null;
    const languageCode =
      typeof googleCloud?.languageCode === 'string' && googleCloud.languageCode.trim() ? googleCloud.languageCode.trim() : null;
    const androidCertSha1 =
      typeof googleCloud?.androidCertSha1 === 'string' && googleCloud.androidCertSha1.trim()
        ? googleCloud.androidCertSha1.trim()
        : null;
    const format = googleCloud?.format === 'wav' ? 'wav' : 'mp3';
    const speakingRate =
      typeof googleCloud?.speakingRate === 'number' && Number.isFinite(googleCloud.speakingRate) ? googleCloud.speakingRate : null;
    const pitch = typeof googleCloud?.pitch === 'number' && Number.isFinite(googleCloud.pitch) ? googleCloud.pitch : null;

    ctx.onSpeaking();
    await speakGoogleCloudText({
      apiKey,
      androidCertSha1,
      input: ctx.text,
      voiceName,
      languageCode,
      format,
      speakingRate,
      pitch,
      timeoutMs: ctx.networkTimeoutMs,
      registerPlaybackStopper: ctx.registerPlaybackStopper,
    }).catch(() => {});
    return;
  }

  // openai_compat
  const baseUrl = String(ctx.tts.openaiCompat.baseUrl ?? '').trim();
  if (!baseUrl) return;
  const apiKey = ctx.tts.openaiCompat.apiKey ? (sync.decryptSecretValue(ctx.tts.openaiCompat.apiKey) ?? null) : null;
  const model = ctx.tts.openaiCompat.model ?? 'tts-1';
  const voice = ctx.tts.openaiCompat.voice ?? 'alloy';
  const format = (ctx.tts.openaiCompat.format ?? 'mp3') as 'mp3' | 'wav';

  ctx.onSpeaking();
  await speakOpenAiCompatText({
    baseUrl,
    apiKey,
    model,
    voice,
    format,
    input: ctx.text,
    timeoutMs: ctx.networkTimeoutMs,
    registerPlaybackStopper: ctx.registerPlaybackStopper,
  }).catch(() => {});
}

