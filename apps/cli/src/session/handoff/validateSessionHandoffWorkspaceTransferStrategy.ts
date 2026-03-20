import type { SessionHandoffWorkspaceTransferInput } from './sessionHandoffWorkspaceTransferInput';

export type SessionHandoffWorkspaceTransferStrategyValidationResult = Readonly<
  | { ok: true }
>;

export function validateSessionHandoffWorkspaceTransferStrategy(params: Readonly<{
  workspaceTransfer?: SessionHandoffWorkspaceTransferInput;
}>): SessionHandoffWorkspaceTransferStrategyValidationResult {
  return { ok: true };
}

export function assertSupportedSessionHandoffWorkspaceTransferStrategy(params: Readonly<{
  workspaceTransfer?: SessionHandoffWorkspaceTransferInput;
}>): void {
  const validation = validateSessionHandoffWorkspaceTransferStrategy(params);
  void validation;
}
