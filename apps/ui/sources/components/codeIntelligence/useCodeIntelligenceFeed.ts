import * as React from 'react';
import { useIsFocused } from '@react-navigation/native';

import { useIsHostVisible } from '@/hooks/ui/useIsHostVisible';
import { fetchCodeIntelligenceSnapshot } from '@/sync/domains/codeIntelligence/codeIntelligenceRpc';
import { mergeCodeIntelligenceSnapshot, type CodeIntelligenceViewState } from '@/sync/domains/codeIntelligence/mergeCodeIntelligenceSnapshot';

/**
 * Machine RPC has no push channel for daemon-local events, so the open screen asks for the delta
 * after its last sequence. The request is small when nothing changed and stops entirely while the
 * screen is unfocused or the window is hidden.
 */
const REFRESH_INTERVAL_MS = 5_000;

export type CodeIntelligenceFeed = Readonly<{
  /** Last known good state; kept through failed refreshes. */
  view: CodeIntelligenceViewState | null;
  phase: 'loading' | 'ready' | 'disabled' | 'unreachable';
  refresh: () => void;
}>;

export function useCodeIntelligenceFeed(target: Readonly<{ serverId: string; machineId: string }> | null): CodeIntelligenceFeed {
  const isFocused = useIsFocused();
  const isHostVisible = useIsHostVisible();
  const [view, setView] = React.useState<CodeIntelligenceViewState | null>(null);
  const [phase, setPhase] = React.useState<CodeIntelligenceFeed['phase']>('loading');
  const viewRef = React.useRef<CodeIntelligenceViewState | null>(null);
  const inFlightRef = React.useRef(false);
  const targetKey = `${target?.serverId ?? ''}/${target?.machineId ?? ''}`;
  const targetKeyRef = React.useRef(targetKey);
  targetKeyRef.current = targetKey;
  const serverId = target?.serverId ?? null;
  const machineId = target?.machineId ?? null;

  const refresh = React.useCallback(() => {
    if (!serverId || !machineId || inFlightRef.current) return;
    inFlightRef.current = true;
    const requestedKey = `${serverId}/${machineId}`;
    const previous = viewRef.current;
    void fetchCodeIntelligenceSnapshot({ serverId, machineId }, previous ? { afterSeq: previous.latestSeq } : {})
      .then((response) => {
        // A reply for a machine the user already switched away from is dropped, not merged.
        if (targetKeyRef.current !== requestedKey) return;
        if (!response.ok) {
          setPhase(response.errorCode === 'code_intelligence_disabled' ? 'disabled' : 'unreachable');
          return;
        }
        const next = mergeCodeIntelligenceSnapshot(viewRef.current, response);
        viewRef.current = next;
        setView(next);
        setPhase('ready');
      })
      .catch(() => {
        if (targetKeyRef.current === requestedKey) setPhase('unreachable');
      })
      .finally(() => {
        inFlightRef.current = false;
      });
  }, [machineId, serverId]);

  // A different machine is a different event stream: never merge across machines.
  React.useEffect(() => {
    viewRef.current = null;
    setView(null);
    setPhase('loading');
  }, [machineId, serverId]);

  React.useEffect(() => {
    if (!isFocused || !isHostVisible) return;
    refresh();
    const timer = setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isFocused, isHostVisible, refresh]);

  return { view, phase, refresh };
}
