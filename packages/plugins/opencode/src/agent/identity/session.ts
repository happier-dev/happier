import { readOpenCodeSessionRuntimeHandleFromMetadata } from './runtimeDescriptor.js';

export const OPEN_CODE_PROVIDER_SESSION_ID_METADATA_KEY = 'opencodeSessionId';

export function readOpenCodeProviderSessionIdFromMetadata(metadata: unknown): string | null {
  return readOpenCodeSessionRuntimeHandleFromMetadata(metadata).providerSessionId;
}

export function writeOpenCodeProviderSessionIdMetadata(providerSessionId: string | null | undefined): Readonly<Record<string, unknown>> {
  const value = typeof providerSessionId === 'string' ? providerSessionId.trim() : '';
  if (!value) return {};
  return { [OPEN_CODE_PROVIDER_SESSION_ID_METADATA_KEY]: value };
}

/**
 * OpenCode's own native session-id contract, and the ONE place the handoff
 * surface decides whether a remote id may be handed to the CLI as an operand.
 *
 * The generic External Sessions remote-id schema intentionally admits
 * provider-specific punctuation, but `opencode export` declares
 * `export [sessionID]` -- an OPTIONAL positional -- next to a `--sanitize`
 * option (OpenCode 1.14.41, `packages/opencode/src/cli/cmd/export.ts`). An
 * option-shaped value such as `--sanitize` therefore lands in the option
 * namespace, leaves the operand absent and switches the command into
 * interactive session selection instead of exporting the requested identity.
 * OpenCode itself declares a session id as `Identifier.schema("session")` =
 * `z.string().startsWith("ses")` (`packages/opencode/src/id/id.ts`), which is
 * both the vendor contract and sufficient to keep an operand an operand. This
 * validates at the native boundary rather than narrowing the protocol-wide
 * remote-id schema.
 */
export function isNativeOpenCodeSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('ses');
}
