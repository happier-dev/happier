import * as React from 'react';

import { Modal } from '@/modal';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { useCurrentUiContextCommandBridge } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';

/**
 * The one way to open the Bots roster from anywhere (rail, palette, phone launcher). Where the rail
 * is mounted its Bots button registers itself and the roster opens anchored to it; everywhere else
 * (phones, narrow windows, a hidden rail) the same roster opens as a sheet. The roster body mounts
 * only while open, so closed entries cost nothing.
 */
export type BotsRosterRuntime = Readonly<{
  open(): void;
  /** The rail's Bots button hands over its own opener while it is mounted. */
  registerAnchoredOpener(open: () => void): () => void;
}>;

const BotsRosterRuntimeContext = React.createContext<BotsRosterRuntime | null>(
  null,
);

export function useOptionalBotsRosterRuntime(): BotsRosterRuntime | null {
  return React.useContext(BotsRosterRuntimeContext);
}

function showBotsRosterSheet(Bridge: React.ComponentType<Readonly<{ children: React.ReactNode }>>): void {
  fireAndForget(
    import('./BotsRosterSheet').then(({ BotsRosterSheet }) => {
      Modal.show({
        component: props => <Bridge><BotsRosterSheet {...props} /></Bridge>,
        chrome: {
          kind: 'card',
          header: 'none',
          title: t('bots.title'),
          phonePresentation: 'sheet',
          scrollHost: 'overlay',
          bodyScroll: 'none',
          testID: 'bots-roster-sheet',
          dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.default, maxHeightRatio: 0.86, size: 'md' },
        },
        closeOnBackdrop: true,
      });
    }),
    { tag: 'BotsRoster.sheet' },
  );
}

export function BotsRosterRuntimeProvider(
  props: Readonly<{ children: React.ReactNode }>,
) {
  const Bridge = useCurrentUiContextCommandBridge();
  // The most recently mounted anchor wins; a remount (rail ↔ peek) re-registers.
  const openersRef = React.useRef<Array<() => void>>([]);
  const runtime = React.useMemo<BotsRosterRuntime>(
    () => ({
      open: () => {
        const anchored = openersRef.current[openersRef.current.length - 1];
        if (anchored) anchored();
        else showBotsRosterSheet(Bridge);
      },
      registerAnchoredOpener: (open) => {
        openersRef.current = [...openersRef.current, open];
        return () => {
          openersRef.current = openersRef.current.filter(
            (candidate) => candidate !== open,
          );
        };
      },
    }),
    [Bridge],
  );
  return (
    <BotsRosterRuntimeContext.Provider value={runtime}>
      {props.children}
    </BotsRosterRuntimeContext.Provider>
  );
}
