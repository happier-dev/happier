import { buildSessionMessagesPath, SessionMessagesPageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import type { BuildSessionMessagesPathParams, SessionMessagesPageV1 } from '@happier-dev/protocol';
import { throwIfAborted } from '../abortSignal.js';

export function parseSessionMessagesPage(json: unknown): SessionMessagesPageV1 {
  const parsed = SessionMessagesPageV1Schema.safeParse(json);
  if (!parsed.success) throw new Error(`Invalid /messages response: ${parsed.error.message}`);
  return parsed.data;
}
export async function fetchSessionMessagesPage(params: BuildSessionMessagesPathParams & Readonly<{
  requestJson: (path: string, signal?: AbortSignal) => Promise<unknown>;
  path?: string;
  signal?: AbortSignal;
  onParse?: (parse: () => SessionMessagesPageV1) => SessionMessagesPageV1;
}>): Promise<SessionMessagesPageV1> {
  throwIfAborted(params.signal);
  const json = await params.requestJson(params.path ?? buildSessionMessagesPath(params), params.signal);
  throwIfAborted(params.signal);
  const parse = () => parseSessionMessagesPage(json);
  return params.onParse ? params.onParse(parse) : parse();
}
