/** What a byte figure measures determines its base across app and daemon notices. */
export type HappierDataBytesKind = 'storage' | 'memory';

const HAPPIER_BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/** Storage uses decimal units; memory uses binary units labelled GB as the OS does. */
export function formatHappierDataBytesParts(bytes: number, options: Readonly<{ kind: HappierDataBytesKind; locale?: string; unit?: 'GiB' }>): Readonly<{ value: string; unit: string }> {
  const base = options.kind === 'memory' ? 1024 : 1000;
  let value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  let index = 0;
  if (options.unit === 'GiB') value /= 1024 ** 3;
  else while (index < HAPPIER_BYTE_UNITS.length - 1 && value >= base) { value /= base; index += 1; }
  let rounded = options.unit !== undefined || value >= 1 ? Number(value.toPrecision(3)) : Math.round(value);
  if (options.unit === undefined && index < HAPPIER_BYTE_UNITS.length - 1 && rounded >= base) { rounded = 1; index += 1; }
  let text: string;
  try {
    text = new Intl.NumberFormat(options.locale === undefined ? undefined : [options.locale], { maximumSignificantDigits: 3 }).format(rounded);
  } catch {
    text = String(rounded);
  }
  return { value: text, unit: options.unit ?? HAPPIER_BYTE_UNITS[index]! };
}

export function formatHappierDataBytes(bytes: number, options: Readonly<{ kind: HappierDataBytesKind; locale?: string; unit?: 'GiB' }>): string {
  const parts = formatHappierDataBytesParts(bytes, options);
  return `${parts.value} ${parts.unit}`;
}
