export function isVoiceQaDebugRuntime(): boolean {
  const runtime = globalThis as typeof globalThis & { __DEV__?: boolean };
  return process.env.EXPO_PUBLIC_DEBUG === '1' || runtime.__DEV__ === true;
}
