import { redactBugReportSensitiveText } from '@happier-dev/protocol';

const MAX_DEBUG_CHARS = 500;
const MARKER_WINDOW_CHARS = 64;

const SENSITIVE_MARKERS: ReadonlyArray<string> = [
  '<permissions instructions',
  '</permissions instructions>',
  '<app-context',
  '</app-context>',
  '<INSTRUCTIONS>',
  '</INSTRUCTIONS>',
];

type AcpStderrLogSummarizerState = {
  insideHarnessContext: boolean;
  trailingText: string;
};

const DEFAULT_SUMMARIZER_STATE: AcpStderrLogSummarizerState = {
  insideHarnessContext: false,
  trailingText: '',
};

function trimTrailingMarkerWindow(text: string): string {
  if (text.length <= MARKER_WINDOW_CHARS) return text;
  return text.slice(-MARKER_WINDOW_CHARS);
}

function hasTrailingSensitiveMarkerPrefix(text: string): boolean {
  return SENSITIVE_MARKERS.some((marker) => marker.startsWith(text) || marker.includes(text));
}

function normalizeForSingleLineLog(text: string): string {
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function summarizeWithState(raw: string, state: AcpStderrLogSummarizerState): {
  summary: string | null;
  nextState: AcpStderrLogSummarizerState;
} {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) {
    return { summary: null, nextState: state };
  }

  const searchText = `${state.trailingText}${trimmed}`;
  const openedHarnessContext = SENSITIVE_MARKERS.some((marker) => searchText.includes(marker));
  const insideHarnessContext = state.insideHarnessContext || openedHarnessContext;
  const closedHarnessContext = insideHarnessContext
    && ['</permissions instructions>', '</app-context>', '</INSTRUCTIONS>'].some((marker) => searchText.includes(marker));

  if (insideHarnessContext) {
    return {
      summary: '[redacted harness context]',
      nextState: {
        insideHarnessContext: !closedHarnessContext,
        trailingText: trimTrailingMarkerWindow(searchText),
      },
    };
  }

  if (hasTrailingSensitiveMarkerPrefix(trimTrailingMarkerWindow(searchText))) {
    return {
      summary: null,
      nextState: {
        insideHarnessContext: false,
        trailingText: trimTrailingMarkerWindow(searchText),
      },
    };
  }

  const normalized = normalizeForSingleLineLog(redactBugReportSensitiveText(trimmed));
  if (!normalized) {
    return {
      summary: null,
      nextState: {
        insideHarnessContext: false,
        trailingText: trimTrailingMarkerWindow(searchText),
      },
    };
  }

  return {
    summary: normalized.length <= MAX_DEBUG_CHARS ? normalized : `${normalized.slice(0, MAX_DEBUG_CHARS)}…`,
    nextState: {
      insideHarnessContext: false,
      trailingText: trimTrailingMarkerWindow(searchText),
    },
  };
}

export function createAcpStderrLogSummarizer(): (raw: string) => string | null {
  let state = DEFAULT_SUMMARIZER_STATE;
  return (raw: string): string | null => {
    const result = summarizeWithState(raw, state);
    state = result.nextState;
    return result.summary;
  };
}

export function summarizeAcpStderrForLogs(raw: string): string | null {
  return summarizeWithState(raw, DEFAULT_SUMMARIZER_STATE).summary;
}
