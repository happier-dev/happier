import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from './index.js';

describe('voice credential broker machine RPC methods', () => {
  it('uses fixed allow-listed method ids rather than a generic authenticated fetch', () => {
    expect(RPC_METHODS.DAEMON_VOICE_CREDENTIAL_STATUS).toBe('daemon.voiceCredentials.status');
    expect(RPC_METHODS.DAEMON_VOICE_CREDENTIAL_STORE).toBe('daemon.voiceCredentials.store');
    expect(RPC_METHODS.DAEMON_VOICE_CREDENTIAL_DELETE).toBe('daemon.voiceCredentials.delete');
    expect(RPC_METHODS.DAEMON_VOICE_CREDENTIAL_MINT_CLIENT_AUTH).toBe('daemon.voiceCredentials.mintClientAuth');
    expect(RPC_METHODS.DAEMON_VOICE_CREDENTIAL_PROVIDER_CATALOG).toBe('daemon.voiceCredentials.providerCatalog');
    expect(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_CHAT).toBe('daemon.voiceOpenAiCompat.chat');
    expect(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_MODELS_LIST).toBe('daemon.voiceOpenAiCompat.models.list');
    expect(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE).toBe('daemon.voiceOpenAiCompat.transcribe');
    expect(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_INIT).toBe('daemon.voiceOpenAiCompat.transcribe.upload.init');
    expect(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_CHUNK).toBe('daemon.voiceOpenAiCompat.transcribe.upload.chunk');
    expect(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_FINALIZE).toBe('daemon.voiceOpenAiCompat.transcribe.upload.finalize');
    expect(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_ABORT).toBe('daemon.voiceOpenAiCompat.transcribe.upload.abort');
    expect(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_SYNTHESIZE).toBe('daemon.voiceOpenAiCompat.synthesize');
    expect(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_DOWNLOAD_CHUNK).toBe('daemon.voiceOpenAiCompat.download.chunk');
    expect(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_DOWNLOAD_FINALIZE).toBe('daemon.voiceOpenAiCompat.download.finalize');
    expect(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_DOWNLOAD_ABORT).toBe('daemon.voiceOpenAiCompat.download.abort');
    expect(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_REQUEST_CANCEL).toBe('daemon.voiceOpenAiCompat.request.cancel');
    expect(Object.values(RPC_METHODS)).not.toContain('daemon.voice.fetch');
  });
});
