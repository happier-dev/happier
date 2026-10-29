import type {
  AGENT_METHODS,
  CLIENT_METHODS,
  SessionUpdate,
} from '@agentclientprotocol/sdk';

export type AcpSdkContractDisposition =
  | 'integrated'
  | 'supported_not_advertised'
  | 'scheduled_owner';

export const ACP_SDK_SESSION_UPDATE_DISPOSITION = {
  user_message_chunk: 'integrated',
  agent_message_chunk: 'integrated',
  agent_thought_chunk: 'integrated',
  tool_call: 'integrated',
  tool_call_update: 'integrated',
  plan: 'integrated',
  plan_update: 'integrated',
  plan_removed: 'integrated',
  available_commands_update: 'integrated',
  current_mode_update: 'integrated',
  config_option_update: 'integrated',
  session_info_update: 'integrated',
  usage_update: 'integrated',
} as const satisfies Record<SessionUpdate['sessionUpdate'], AcpSdkContractDisposition>;

export type AcpSessionUpdateDisposition =
  | Readonly<{ kind: 'stable'; disposition: AcpSdkContractDisposition }>
  | Readonly<{ kind: 'unknown_extension' }>;

export function classifyAcpSessionUpdateDisposition(value: unknown): AcpSessionUpdateDisposition {
  if (
    typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(ACP_SDK_SESSION_UPDATE_DISPOSITION, value)
  ) {
    return {
      kind: 'stable',
      disposition: ACP_SDK_SESSION_UPDATE_DISPOSITION[
        value as keyof typeof ACP_SDK_SESSION_UPDATE_DISPOSITION
      ],
    };
  }
  return { kind: 'unknown_extension' };
}

export function buildUnknownAcpSessionUpdateDiagnostic(update: unknown): Readonly<{
  sessionUpdate: string;
  keys: readonly string[];
  truncatedKeyCount: number;
}> {
  const record = update && typeof update === 'object' && !Array.isArray(update)
    ? update as Record<string, unknown>
    : {};
  const rawType = typeof record.sessionUpdate === 'string' ? record.sessionUpdate : 'unknown';
  const keys = Object.keys(record);
  return {
    sessionUpdate: rawType.slice(0, 128),
    keys: keys.slice(0, 50).map((key) => key.slice(0, 128)),
    truncatedKeyCount: Math.max(0, keys.length - 50),
  };
}

export const ACP_SDK_AGENT_METHOD_DISPOSITION = {
  initialize: 'integrated',
  authenticate: 'integrated',
  'providers/list': 'supported_not_advertised',
  'providers/set': 'supported_not_advertised',
  'providers/disable': 'supported_not_advertised',
  'session/new': 'integrated',
  'session/load': 'integrated',
  'session/set_mode': 'integrated',
  'session/set_config_option': 'integrated',
  'session/prompt': 'integrated',
  'session/cancel': 'integrated',
  'mcp/message': 'supported_not_advertised',
  'session/list': 'integrated',
  'session/delete': 'integrated',
  'session/fork': 'integrated',
  'session/resume': 'supported_not_advertised',
  'session/close': 'integrated',
  logout: 'supported_not_advertised',
  'nes/start': 'supported_not_advertised',
  'nes/suggest': 'supported_not_advertised',
  'nes/accept': 'supported_not_advertised',
  'nes/reject': 'supported_not_advertised',
  'nes/close': 'supported_not_advertised',
  'document/didOpen': 'supported_not_advertised',
  'document/didChange': 'supported_not_advertised',
  'document/didClose': 'supported_not_advertised',
  'document/didSave': 'supported_not_advertised',
  'document/didFocus': 'supported_not_advertised',
} as const satisfies Record<(typeof AGENT_METHODS)[keyof typeof AGENT_METHODS], AcpSdkContractDisposition>;

export const ACP_SDK_CLIENT_METHOD_DISPOSITION = {
  'session/request_permission': 'integrated',
  'session/update': 'integrated',
  'fs/write_text_file': 'integrated',
  'fs/read_text_file': 'integrated',
  'terminal/create': 'supported_not_advertised',
  'terminal/output': 'supported_not_advertised',
  'terminal/release': 'supported_not_advertised',
  'terminal/wait_for_exit': 'supported_not_advertised',
  'terminal/kill': 'supported_not_advertised',
  'mcp/connect': 'supported_not_advertised',
  'mcp/message': 'supported_not_advertised',
  'mcp/disconnect': 'supported_not_advertised',
  'elicitation/create': 'supported_not_advertised',
  'elicitation/complete': 'supported_not_advertised',
} as const satisfies Record<(typeof CLIENT_METHODS)[keyof typeof CLIENT_METHODS], AcpSdkContractDisposition>;
