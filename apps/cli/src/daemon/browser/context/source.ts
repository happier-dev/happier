import type { BrowserContextSource } from './capture';

export type { BrowserContextSource } from './capture';

/**
 * Fail-closed context source used when no executable capture producer is host-wired.
 * The chromiumSidecar control adapter does not expose a CDP capture producer through
 * its public interface, so the daemon context routes construct (the gate flips from
 * "route unavailable" to a real route owner) but every capture honestly reports the
 * adapter as unavailable until a managed source lands (FP-BRW-SOURCE-1).
 */
export function createUnavailableBrowserContextSource(): BrowserContextSource {
  const unavailable = {
    ok: false as const,
    reason: 'adapter_unavailable' as const,
    disabledReason: 'browser sidecar context capture producer unavailable',
  };
  return {
    capturePage: async () => unavailable,
    captureScreenshot: async () => unavailable,
    captureSummary: async () => unavailable,
    captureSelectedElement: async () => unavailable,
  };
}
