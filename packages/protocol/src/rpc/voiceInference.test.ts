import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from './index.js';

describe('RPC_METHODS (daemon voice inference)', () => {
  it('includes daemon.voiceInference.* methods', () => {
    expect((RPC_METHODS as any).DAEMON_VOICE_INFERENCE_STATUS).toBe('daemon.voiceInference.status');
    expect((RPC_METHODS as any).DAEMON_VOICE_INFERENCE_MODELS_LIST).toBe('daemon.voiceInference.models.list');
    expect((RPC_METHODS as any).DAEMON_VOICE_INFERENCE_MODELS_INSTALL).toBe('daemon.voiceInference.models.install');
    expect((RPC_METHODS as any).DAEMON_VOICE_INFERENCE_MODELS_REMOVE).toBe('daemon.voiceInference.models.remove');
    expect((RPC_METHODS as any).DAEMON_VOICE_INFERENCE_MODELS_STATUS).toBe('daemon.voiceInference.models.status');
    expect((RPC_METHODS as any).DAEMON_VOICE_INFERENCE_MODELS_WARM).toBe('daemon.voiceInference.models.warm');
    expect((RPC_METHODS as any).DAEMON_VOICE_INFERENCE_TTS_SYNTHESIZE).toBe('daemon.voiceInference.tts.synthesize');
    expect((RPC_METHODS as any).DAEMON_VOICE_INFERENCE_TTS_CHUNK).toBe('daemon.voiceInference.tts.chunk');
    expect((RPC_METHODS as any).DAEMON_VOICE_INFERENCE_TTS_FINALIZE).toBe('daemon.voiceInference.tts.finalize');
    expect((RPC_METHODS as any).DAEMON_VOICE_INFERENCE_TTS_ABORT).toBe('daemon.voiceInference.tts.abort');
    expect((RPC_METHODS as any).DAEMON_VOICE_INFERENCE_TTS_CANCEL).toBe('daemon.voiceInference.tts.cancel');
    expect((RPC_METHODS as any).DAEMON_VOICE_INFERENCE_TTS_STREAM_START).toBe('daemon.voiceInference.tts.stream.start');
    expect((RPC_METHODS as any).DAEMON_VOICE_INFERENCE_TTS_STREAM_NEXT).toBe('daemon.voiceInference.tts.stream.next');
    expect((RPC_METHODS as any).DAEMON_VOICE_INFERENCE_TTS_STREAM_ACK).toBe('daemon.voiceInference.tts.stream.ack');
    expect((RPC_METHODS as any).DAEMON_VOICE_INFERENCE_TTS_STREAM_CANCEL).toBe('daemon.voiceInference.tts.stream.cancel');
    expect((RPC_METHODS as any).DAEMON_VOICE_INFERENCE_TTS_STREAM_STATUS).toBe('daemon.voiceInference.tts.stream.status');
    expect((RPC_METHODS as any).DAEMON_VOICE_INFERENCE_STT_UPLOAD_INIT).toBe('daemon.voiceInference.stt.upload.init');
    expect((RPC_METHODS as any).DAEMON_VOICE_INFERENCE_STT_UPLOAD_CHUNK).toBe('daemon.voiceInference.stt.upload.chunk');
    expect((RPC_METHODS as any).DAEMON_VOICE_INFERENCE_STT_UPLOAD_FINALIZE).toBe('daemon.voiceInference.stt.upload.finalize');
    expect((RPC_METHODS as any).DAEMON_VOICE_INFERENCE_STT_UPLOAD_ABORT).toBe('daemon.voiceInference.stt.upload.abort');
    expect((RPC_METHODS as any).DAEMON_VOICE_INFERENCE_STT_TRANSCRIBE).toBe('daemon.voiceInference.stt.transcribe');
    expect((RPC_METHODS as any).DAEMON_VOICE_INFERENCE_STT_CANCEL).toBe('daemon.voiceInference.stt.cancel');
    expect((RPC_METHODS as any).DAEMON_VOICE_INFERENCE_STT_STREAM_START).toBe('daemon.voiceInference.stt.stream.start');
    expect((RPC_METHODS as any).DAEMON_VOICE_INFERENCE_STT_STREAM_CHUNK).toBe('daemon.voiceInference.stt.stream.chunk');
    expect((RPC_METHODS as any).DAEMON_VOICE_INFERENCE_STT_STREAM_FINISH).toBe('daemon.voiceInference.stt.stream.finish');
    expect((RPC_METHODS as any).DAEMON_VOICE_INFERENCE_STT_STREAM_CANCEL).toBe('daemon.voiceInference.stt.stream.cancel');
    expect((RPC_METHODS as any).DAEMON_VOICE_INFERENCE_STT_STREAM_STATUS).toBe('daemon.voiceInference.stt.stream.status');
  });
});
