import type { InitializeResponse } from '@agentclientprotocol/sdk';
import { AgentRuntimeJsonValueV1Schema } from '@happier-dev/protocol/runtime/agentSessionV1';

const MAX_AUTH_METHODS = 64;
const MAX_AUTH_METHOD_ID_CODE_UNITS = 256;
const MAX_INITIALIZE_METADATA_CODE_UNITS = 16_384;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export type AcpAuthenticationSelection = Readonly<{
  methodId: string;
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type AcpAuthenticationSelector = (context: Readonly<{
  advertisedMethodIds: readonly string[];
  initializeMetadata: Readonly<Record<string, unknown>> | null;
}>) => AcpAuthenticationSelection | null | Promise<AcpAuthenticationSelection | null>;

export function readAdvertisedAuthMethodIds(initResponse: InitializeResponse): readonly string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  const methods = Array.isArray(initResponse.authMethods) ? initResponse.authMethods : [];
  for (const method of methods) {
    if (output.length >= MAX_AUTH_METHODS) break;
    const record = asRecord(method);
    const rawId = record?.id;
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (!id || id.length > MAX_AUTH_METHOD_ID_CODE_UNITS || seen.has(id)) continue;
    seen.add(id);
    output.push(id);
  }
  return Object.freeze(output);
}

export function readBoundedInitializeMetadata(
  initResponse: InitializeResponse,
): Readonly<Record<string, unknown>> | null {
  const candidate = asRecord(initResponse)?.['_meta'];
  const parsed = AgentRuntimeJsonValueV1Schema.safeParse(candidate);
  if (!parsed.success) return null;
  const record = asRecord(parsed.data);
  if (!record || JSON.stringify(record).length > MAX_INITIALIZE_METADATA_CODE_UNITS) return null;
  return Object.freeze({ ...record });
}

export function validateAuthenticationSelection(
  selection: AcpAuthenticationSelection,
  advertisedMethodIds: readonly string[],
): AcpAuthenticationSelection {
  const methodId = typeof selection.methodId === 'string' ? selection.methodId.trim() : '';
  if (!methodId || methodId.length > MAX_AUTH_METHOD_ID_CODE_UNITS) {
    throw new Error('[AcpBackend] ACP authentication selector returned an invalid method id');
  }
  if (!advertisedMethodIds.includes(methodId)) {
    throw new Error(`[AcpBackend] ACP agent does not advertise auth method '${methodId}'`);
  }
  const metadata = selection.metadata;
  if (metadata === undefined) return Object.freeze({ methodId });
  const parsed = AgentRuntimeJsonValueV1Schema.safeParse(metadata);
  const record = parsed.success ? asRecord(parsed.data) : null;
  if (!record || JSON.stringify(record).length > MAX_INITIALIZE_METADATA_CODE_UNITS) {
    throw new Error('[AcpBackend] ACP authentication selector returned invalid metadata');
  }
  return Object.freeze({ methodId, metadata: Object.freeze({ ...record }) });
}
