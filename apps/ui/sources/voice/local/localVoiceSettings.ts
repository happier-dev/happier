export function resolveLocalVoiceAdapterSettings(settings: any): {
  adapterId: 'local_direct' | 'local_conversation';
  config: any;
} {
  const voice = settings?.voice ?? null;
  const providerId = voice?.providerId;
  if (providerId === 'local_direct') {
    return { adapterId: 'local_direct', config: voice?.adapters?.local_direct ?? {} };
  }
  if (providerId === 'local_conversation') {
    return { adapterId: 'local_conversation', config: voice?.adapters?.local_conversation ?? {} };
  }
  return {
    adapterId: 'local_conversation',
    config: voice?.adapters?.local_conversation ?? voice?.adapters?.local_direct ?? {},
  };
}

export function resolveLocalSttProvider(settings: any): 'device' | 'openai_compat' | 'google_gemini' | 'local_neural' {
  const { config } = resolveLocalVoiceAdapterSettings(settings);
  const stt = config?.stt ?? null;
  const provider = typeof stt?.provider === 'string' ? stt.provider : null;
  if (provider === 'device' || provider === 'openai_compat' || provider === 'google_gemini' || provider === 'local_neural') {
    return provider;
  }

  // Legacy shape (pre-provider refactor).
  if (stt?.useDeviceStt === true) return 'device';
  return 'openai_compat';
}

export function isHandsFreeDeviceSttEnabled(settings: any): boolean {
  const { config } = resolveLocalVoiceAdapterSettings(settings);
  return resolveLocalSttProvider(settings) === 'device' && config?.handsFree?.enabled === true;
}

export function isHandsFreeLocalNeuralSttEnabled(settings: any): boolean {
  const { config } = resolveLocalVoiceAdapterSettings(settings);
  return resolveLocalSttProvider(settings) === 'local_neural' && config?.handsFree?.enabled === true;
}

export function isVoiceBargeInEnabled(settings: any): boolean {
  const { config } = resolveLocalVoiceAdapterSettings(settings);
  return config?.tts?.bargeInEnabled === true;
}
