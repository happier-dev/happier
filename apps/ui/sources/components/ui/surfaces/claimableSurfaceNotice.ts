import * as React from 'react';
import { PluginUiSurfaceNoticeContext, type PluginUiSurfaceNotice } from '@happier-dev/plugin-ui/advanced';

import { SurfaceStateContentContext } from './SurfaceStateCard';

export type ClaimableSurfaceNoticeContent = Readonly<{
  sentence: string;
  action?: PluginUiSurfaceNotice['action'];
}>;

/**
 * One host sentence that a body's own failure state may claim and say in its own place (the plugin-ui claim seam,
 * `PluginUiSurfaceNoticeContext`). The host draws its line only while nothing claims it. While a body claims it, that
 * part of the body is the one line, so the frame around it sizes to the line instead of holding a tall empty room
 * (owner 2026-11-11). The offline notice and the widget Machine notice offer their sentences through this one owner.
 * `content` keeps its identity while unchanged, so the notice a body reads does too.
 */
export function useClaimableSurfaceNotice(
  content: ClaimableSurfaceNoticeContent | null,
): Readonly<{
  notice: PluginUiSurfaceNotice | null;
  claimed: boolean;
}> {
  const reportContent = React.useContext(SurfaceStateContentContext);
  // A surrounding host already knows the cause and recovery (for example, no Machine can run this plugin).
  // An inner offline notice relays that offer instead of replacing it with a generic failure.
  const outer = React.useContext(PluginUiSurfaceNoticeContext);
  const inherited = content === null ? null : outer;
  const offered = content === null ? null : inherited ?? content;
  const [claimants, setClaimants] =
    React.useState<ReadonlySet<string>>(NO_CLAIMANTS);
  const claim = React.useCallback((id: string) => {
    const releaseOuter = inherited?.claim(id);
    setClaimants((current) =>
      current.has(id) ? current : new Set(current).add(id),
    );
    return () => {
      releaseOuter?.();
      setClaimants((current) => {
        if (!current.has(id)) return current;
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    };
  }, [inherited]);
  const notice = React.useMemo<PluginUiSurfaceNotice | null>(
    () =>
      offered === null
        ? null
        : {
            ...offered,
            claim,
          },
    [claim, offered],
  );
  const claimed = notice !== null && claimants.size > 0;
  const [reportKey] = React.useState(() => Symbol('claimed-surface-notice'));
  React.useEffect(() => {
    if (!claimed || !reportContent) return;
    reportContent(reportKey, { empty: false, line: true, loading: false });
    return () => reportContent(reportKey, null);
  }, [claimed, reportContent, reportKey]);
  return { notice, claimed };
}

const NO_CLAIMANTS: ReadonlySet<string> = new Set();
