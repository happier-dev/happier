import axios from '@/api/client/credentialAxios';
import { AutonomousExchangeStatusV1Schema,
  type AutonomousExchangeControlRequestV1 } from '@happier-dev/protocol/sessions/messages/autonomousExchangeV1';

export function autonomousExchangePath(sessionId: string, originInputLocalId: string): string {
  return `/v2/sessions/${encodeURIComponent(sessionId)}/exchanges/${encodeURIComponent(originInputLocalId)}`;
}

/** Exact Home/headers are supplied by the admitted Action owner; this adapter only transports. */
export async function readAutonomousExchangeStatus(input: Readonly<{
  serverHttpBaseUrl: string;
  path: string;
  headers: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}>) {
  const response = await axios.get<unknown>(`${input.serverHttpBaseUrl}${input.path}`, {
    headers: input.headers, ...(input.signal ? { signal: input.signal } : {}), validateStatus: () => true,
  });
  if (response.status < 200 || response.status >= 300) return null;
  const parsed = AutonomousExchangeStatusV1Schema.safeParse(response.data);
  return parsed.success ? parsed.data : null;
}

export async function mutateAutonomousExchangeControl(input: Readonly<{
  serverHttpBaseUrl: string;
  path: string;
  headers: Readonly<Record<string, string>>;
  request: AutonomousExchangeControlRequestV1;
  signal?: AbortSignal;
}>) {
  const response = await axios.post<unknown>(`${input.serverHttpBaseUrl}${input.path}`, input.request, {
    headers: input.headers, ...(input.signal ? { signal: input.signal } : {}), validateStatus: () => true,
  });
  const parsed = AutonomousExchangeStatusV1Schema.safeParse(response.data);
  return { status: response.status, result: parsed.success ? parsed.data : null };
}
