/** Decode labeled native version output, shared by installed source adapters. */
export function parseInstalledVersionFromOutput(command: string, stdout: string): string | null {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const commandMatch = new RegExp(`\\b${escaped}\\s+version\\s*:?[\\t ]*v?([0-9]+(?:\\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]+)?)`, 'i').exec(stdout);
  if (commandMatch?.[1]) return commandMatch[1];
  const genericMatch = /\bversion\s*:?[\t ]*v?([0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]+)?)/i.exec(stdout);
  return genericMatch?.[1] ?? null;
}
