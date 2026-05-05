export function truncateEnd(value: string, width: number): string {
  const text = String(value ?? '');
  if (width <= 0) return '';
  if (text.length <= width) return text;
  if (width <= 1) return text.slice(0, width);
  return text.slice(0, width - 1) + '…';
}

export function truncateMiddle(value: string, width: number): string {
  const text = String(value ?? '');
  if (width <= 0) return '';
  if (text.length <= width) return text;
  if (width <= 3) return text.slice(0, width);
  const remaining = width - 1;
  const headLen = Math.floor(remaining * 0.4);
  const tailLen = remaining - headLen;
  return `${text.slice(0, headLen)}…${text.slice(text.length - tailLen)}`;
}

export function padRight(value: string, width: number): string {
  const text = String(value ?? '');
  if (text.length >= width) return text;
  return text + ' '.repeat(width - text.length);
}

export function padLeft(value: string, width: number): string {
  const text = String(value ?? '');
  if (text.length >= width) return text;
  return ' '.repeat(width - text.length) + text;
}

export type SessionSelectorColumnLayout = Readonly<{
  indicatorWidth: number;
  titleWidth: number;
  agentWidth: number;
  updatedWidth: number;
  idWidth: number;
  pathWidth: number;
  separatorWidth: number;
}>;

export function resolveSessionSelectorColumnLayout(termWidth: number): SessionSelectorColumnLayout | null {
  const indicatorWidth = 2;
  const agentWidth = 8;
  const updatedWidth = 4;
  const idWidth = 9;
  const separatorWidth = 1;
  const fixedWidths = indicatorWidth + agentWidth + updatedWidth + idWidth;
  const separators = separatorWidth * 5;
  const remaining = termWidth - fixedWidths - separators;
  if (remaining < 20) return null;
  const titleWidth = Math.max(8, Math.floor(remaining * 0.35));
  const pathWidth = Math.max(8, remaining - titleWidth - separatorWidth);
  return {
    indicatorWidth,
    titleWidth,
    agentWidth,
    updatedWidth,
    idWidth,
    pathWidth,
    separatorWidth,
  };
}
