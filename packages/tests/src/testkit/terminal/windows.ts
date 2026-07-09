export type WindowsConptyProbe = Readonly<{
  platform: string;
  emittedType: 'buffer' | 'string' | 'unknown';
  checksumMatches: boolean;
}>;

export type WindowsConptyByteSupportDiagnostic =
  | Readonly<{
      state: 'not-windows';
      byteStreamAdvertised: false;
    }>
  | Readonly<{
      state: 'byte-capable';
      byteStreamAdvertised: true;
    }>
  | Readonly<{
      state: 'legacy-only';
      reason: 'raw-bytes-not-proven';
      byteStreamAdvertised: false;
    }>;

export function classifyWindowsConptyByteSupport(
  probe: WindowsConptyProbe,
): WindowsConptyByteSupportDiagnostic {
  if (probe.platform !== 'win32') {
    return {
      state: 'not-windows',
      byteStreamAdvertised: false,
    };
  }

  if (probe.emittedType === 'buffer' && probe.checksumMatches) {
    return {
      state: 'byte-capable',
      byteStreamAdvertised: true,
    };
  }

  return {
    state: 'legacy-only',
    reason: 'raw-bytes-not-proven',
    byteStreamAdvertised: false,
  };
}
