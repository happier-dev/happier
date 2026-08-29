export const CODEX_APP_SERVER_ARGS = Object.freeze([
  'app-server',
  '--listen',
  'stdio://',
] as const);

export const CODEX_REALTIME_CONVERSATION_FEATURE = 'realtime_conversation';

export const CODEX_APP_SERVER_CLIENT_INFO = Object.freeze({
  name: 'happier_cli',
  title: 'Happier',
  version: '0.1.0',
});

export const CODEX_APP_SERVER_INITIALIZE_PARAMS = Object.freeze({
  clientInfo: CODEX_APP_SERVER_CLIENT_INFO,
  capabilities: Object.freeze({ experimentalApi: true }),
});

export async function initializeCodexAppServerClient(client: Readonly<{
  request(
    method: string,
    params: typeof CODEX_APP_SERVER_INITIALIZE_PARAMS,
  ): Promise<unknown>;
  notify(method: string): Promise<void>;
}>): Promise<void> {
  await client.request('initialize', CODEX_APP_SERVER_INITIALIZE_PARAMS);
  await client.notify('initialized');
}

export function buildCodexAppServerBaseArgs(
  enableRealtimeConversation: boolean,
): readonly string[] {
  return Object.freeze([
    ...CODEX_APP_SERVER_ARGS,
    ...(enableRealtimeConversation
      ? ['--enable', CODEX_REALTIME_CONVERSATION_FEATURE]
      : []),
  ]);
}
