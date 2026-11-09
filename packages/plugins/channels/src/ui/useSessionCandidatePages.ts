import * as React from 'react';
import { useExecutePluginAction } from '@happier-dev/plugin-ui';

export type SessionCandidate = Readonly<{ id: string; label: string }>;
type SessionCandidatePage = Readonly<{
  candidates: readonly SessionCandidate[];
  nextCursor?: string;
  incomplete?: boolean;
}>;

function parseSessionCandidatePage(value: unknown): SessionCandidatePage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const page = value as Record<string, unknown>;
  if (page.view !== 'awareness' || page.projectionVersion !== 1) return undefined;
  if (!Array.isArray(page.sessions)) return undefined;
  const nonEmpty = (entry: unknown): entry is string => typeof entry === 'string' && entry.trim().length > 0;
  if (page.nextCursor !== undefined && page.nextCursor !== null && !nonEmpty(page.nextCursor)) return undefined;
  const seen = new Set<string>();
  const candidates: SessionCandidate[] = [];
  for (const value of page.sessions) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (!nonEmpty(entry.sessionId) || seen.has(entry.sessionId)) continue;
    seen.add(entry.sessionId);
    // Titles are sufficient for picking a Session; transcript previews stay private.
    candidates.push({ id: entry.sessionId, label: nonEmpty(entry.title) ? entry.title : 'Session' });
  }
  return {
    candidates,
    ...(nonEmpty(page.nextCursor) ? { nextCursor: page.nextCursor } : {}),
  };
}

function parseDiscussionCandidatePage(value: unknown): SessionCandidatePage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const page = value as Record<string, unknown>;
  if (page.v !== 1 || typeof page.serverId !== 'string' || !Array.isArray(page.discussions)
    || typeof page.incomplete !== 'boolean') return undefined;
  if (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || page.nextCursor.length === 0)) return undefined;
  const seen = new Set<string>();
  const candidates: SessionCandidate[] = [];
  for (const value of page.discussions) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const discussion = value as Record<string, unknown>;
    if (typeof discussion.id !== 'string' || discussion.id.length === 0 || seen.has(discussion.id)) continue;
    const capabilities = discussion.capabilities;
    if (typeof capabilities !== 'object' || capabilities === null || Array.isArray(capabilities)) continue;
    // Consume the Discussion owner's permission and key facts; never infer
    // posting authority from ownership, membership or a readable title.
    if ((capabilities as Record<string, unknown>).postMessages !== true || discussion.keyReadiness !== true
      || discussion.archivedAt !== null) continue;
    seen.add(discussion.id);
    candidates.push({ id: discussion.id, label: typeof discussion.title === 'string' && discussion.title.trim() !== ''
      ? discussion.title : 'Discussion' });
  }
  return { candidates, incomplete: page.incomplete,
    ...(typeof page.nextCursor === 'string' ? { nextCursor: page.nextCursor } : {}) };
}

type CandidatePageOptions = Readonly<{
  signal?: AbortSignal;
  isLocked?: () => boolean;
  onStarted?: () => void;
  onUnavailable?: () => void;
}>;

/** One cursor and read lifecycle for Channels' paged Account target pickers. */
function useTargetCandidatePages(
  actionId: 'session.list' | 'discussion.list',
  parsePage: (value: unknown) => SessionCandidatePage | undefined,
  inputForCursor: (cursor?: string) => Readonly<Record<string, string | number>>,
  options: CandidatePageOptions,
) {
  const action = useExecutePluginAction(actionId);
  const execute = action.execute;
  const optionsRef = React.useRef(options);
  optionsRef.current = options;
  const mountedRef = React.useRef(true);
  const inFlightRef = React.useRef(false);
  const attemptedCursorRef = React.useRef<string | undefined>(undefined);
  const [candidates, setCandidates] = React.useState<readonly SessionCandidate[]>([]);
  const [nextCursor, setNextCursor] = React.useState<string | undefined>();
  const [loaded, setLoaded] = React.useState(false);
  const [unavailable, setUnavailable] = React.useState(false);
  const [incomplete, setIncomplete] = React.useState(false);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = React.useCallback(async (cursor?: string) => {
    const current = optionsRef.current;
    if (inFlightRef.current || current.signal?.aborted || current.isLocked?.()) return;
    inFlightRef.current = true;
    attemptedCursorRef.current = cursor;
    setUnavailable(false);
    current.onStarted?.();
    try {
      const settled = await execute(inputForCursor(cursor));
      if (!mountedRef.current || current.signal?.aborted) return;
      const page = settled.status === 'success' ? parsePage(settled.result) : undefined;
      if (page === undefined) {
        setUnavailable(true);
        optionsRef.current.onUnavailable?.();
        return;
      }
      setCandidates((previous) => {
        if (cursor === undefined) return page.candidates;
        const seen = new Set(previous.map((candidate) => candidate.id));
        const appended = page.candidates.filter((candidate) => {
          if (seen.has(candidate.id)) return false;
          seen.add(candidate.id);
          return true;
        });
        return appended.length === 0 ? previous : [...previous, ...appended];
      });
      setNextCursor(page.nextCursor);
      setIncomplete((previous) => (cursor === undefined ? page.incomplete === true : previous || page.incomplete === true));
    } catch {
      if (!mountedRef.current || current.signal?.aborted) return;
      setUnavailable(true);
      optionsRef.current.onUnavailable?.();
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current && !current.signal?.aborted) setLoaded(true);
    }
  }, [execute, inputForCursor, parsePage]);

  const retry = React.useCallback(() => load(attemptedCursorRef.current), [load]);
  const reset = React.useCallback(() => {
    setCandidates([]);
    setNextCursor(undefined);
    setLoaded(false);
    setUnavailable(false);
    setIncomplete(false);
    attemptedCursorRef.current = undefined;
  }, []);

  return {
    candidates,
    nextCursor,
    loaded,
    unavailable,
    incomplete,
    loading: action.execution.status === 'pending',
    execution: action.execution,
    load,
    retry,
    reset,
  };
}

const sessionPageInput = (cursor?: string) => ({ view: 'awareness', limit: 100, ...(cursor === undefined ? {} : { cursor }) });
const discussionPageInput = (cursor?: string) => ({ state: 'active', ...(cursor === undefined ? {} : { cursor }) });

export function useSessionCandidatePages(options: CandidatePageOptions = {}) {
  return useTargetCandidatePages('session.list', parseSessionCandidatePage, sessionPageInput, options);
}

export function useDiscussionCandidatePages(options: CandidatePageOptions = {}) {
  return useTargetCandidatePages('discussion.list', parseDiscussionCandidatePage, discussionPageInput, options);
}
