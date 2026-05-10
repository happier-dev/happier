import type { SessionStateProviderFieldHandler } from '@happier-dev/agents';

type CodexAppServerTitleClient = Readonly<{
  request(method: 'thread/name/set', params: Readonly<{ threadId: string; name: string }>): Promise<unknown>;
}>;

function normalizeNonEmptyString(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || null;
}

/**
 * Transitional Codex app-server owner for display.title provider mirroring.
 *
 * Final owner after backend extraction: packages/plugins/codex/src/agent/state/displayTitle.ts.
 */
export function createCodexAppServerDisplayTitleHandler(params: Readonly<{
  client: CodexAppServerTitleClient;
  getThreadId: () => string | null;
}>): SessionStateProviderFieldHandler<'display.title'> {
  return {
    applyHappierField: async (_ctx, titleValue) => {
      const threadId = normalizeNonEmptyString(params.getThreadId());
      const title = normalizeNonEmptyString(titleValue);
      if (!threadId || !title) return;

      try {
        await params.client.request('thread/name/set', {
          threadId,
          name: title,
        });
      } catch {
        // Provider title mirroring is best-effort; Happier's canonical title write already succeeded.
      }
    },
  };
}
