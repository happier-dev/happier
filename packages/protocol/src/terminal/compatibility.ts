export const TERMINAL_LEGACY_STREAM_COMPATIBILITY = Object.freeze({
  schemaVersion: 1,
  capability: 'terminal.transport.byteStream',
  supportedLegacyClientReleases: ['0.2.10'] as const,
  removalRelease: '0.3.0',
  windowsProviderFallback: 'separate-capability' as const,
});

export type TerminalPeerByteStreamCapability = 'enabled' | 'disabled' | 'unknown';

export function isTerminalLegacyClientFallbackAllowed(input: Readonly<{
  currentAppRelease: string;
  peerByteStreamCapability: TerminalPeerByteStreamCapability;
}>): boolean {
  if (input.peerByteStreamCapability === 'enabled') {
    return false;
  }
  if (compareTerminalRelease(input.currentAppRelease, TERMINAL_LEGACY_STREAM_COMPATIBILITY.removalRelease) >= 0) {
    return false;
  }
  return TERMINAL_LEGACY_STREAM_COMPATIBILITY.supportedLegacyClientReleases.some(
    (release) => release === input.currentAppRelease,
  );
}

export function isTerminalLegacyCompatibilitySunsetReached(currentAppRelease: string): boolean {
  return compareTerminalRelease(currentAppRelease, TERMINAL_LEGACY_STREAM_COMPATIBILITY.removalRelease) >= 0;
}

function compareTerminalRelease(left: string, right: string): number {
  const parse = (value: string): readonly [number, number, number] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  if (!leftParts || !rightParts) return 1;
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index]! < rightParts[index]! ? -1 : 1;
  }
  return 0;
}

export function isWindowsTerminalProviderLegacyFallbackAllowed(input: Readonly<{
  provider: string;
  byteFidelityProven: boolean;
}>): boolean {
  return input.provider === 'windows-conpty' && !input.byteFidelityProven;
}
