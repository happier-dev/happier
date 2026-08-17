import * as React from 'react';

export type HappierCodeBlockBehaviorInput = Readonly<{
  language?: string | null;
  showHeaderRow: boolean;
  showCopyButton: boolean;
  hasHeaderLeft: boolean;
  hasHeaderRight: boolean;
  onCopy: () => unknown;
  copiedDurationMs?: number;
}>;

/** Normalize the optional syntax label shared by app and public code blocks. */
export function normalizeHappierCodeLanguage(language: string | null | undefined): string | undefined {
  const normalized = language?.trim().toLowerCase();
  return normalized ? normalized.slice(0, 64) : undefined;
}

export function resolveHappierCodeBlockLayout(input: Pick<
  HappierCodeBlockBehaviorInput,
  'language' | 'showHeaderRow' | 'showCopyButton' | 'hasHeaderLeft' | 'hasHeaderRight'
>) {
  const language = normalizeHappierCodeLanguage(input.language);
  const header = input.showHeaderRow && (Boolean(language) || input.hasHeaderLeft || input.hasHeaderRight);
  return {
    language,
    shouldRenderHeaderRow: header,
    shouldOverlayCopyButton: input.showCopyButton && !header,
  } as const;
}

/** One copy settlement/timer and header-placement owner for app and public code blocks. */
export function useHappierCodeBlockBehavior(input: HappierCodeBlockBehaviorInput) {
  const [copied, setCopied] = React.useState(false);
  const resetTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = React.useRef(true);
  const layout = resolveHappierCodeBlockLayout(input);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  const copy = React.useCallback(async () => {
    try {
      await input.onCopy();
      if (!mountedRef.current) return true;
      setCopied(true);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => {
        if (mountedRef.current) setCopied(false);
      }, input.copiedDurationMs ?? 1_200);
      return true;
    } catch {
      return false;
    }
  }, [input.copiedDurationMs, input.onCopy]);

  return { ...layout, copied, copy } as const;
}
