import * as React from 'react';
import { readPressFocusReturnTarget, useInlineLevelFocusReturn } from '@/keyboard/focusReturn';
import {
  ExecutableParticipantPickerBody,
  type ExecutableParticipantChoice,
  type ExecutableParticipantPickerInput,
} from './ExecutableParticipantPickerBody';

type Request = ExecutableParticipantPickerInput & Readonly<{ signal: AbortSignal }>;
type Pending = Readonly<{ request: Request; resolve: (choice: ExecutableParticipantChoice | null) => void }>;

/** Adapts the existing input-picker Promise port to its mounted host's inline Browse/Back state. */
export function useInlineExecutableParticipantPicker() {
  const [pending, setPending] = React.useState<Pending | null>(null);
  const current = React.useRef<Pending | null>(null);
  // The host keeps its Browse control mounted (hidden) under the picker; the picker's close returns focus to it.
  const { originRef: browseOrigin, attachEntry } = useInlineLevelFocusReturn(pending !== null);
  React.useEffect(() => () => current.current?.resolve(null), []);
  const pick = React.useCallback((request: Request): Promise<ExecutableParticipantChoice | null> => {
    current.current?.resolve(null);
    if (request.signal.aborted) return Promise.resolve(null);
    browseOrigin.current = readPressFocusReturnTarget(null);
    return new Promise(resolve => {
      const cancel = () => entry.resolve(null);
      const entry: Pending = { request, resolve: choice => {
        if (current.current !== entry) return;
        request.signal.removeEventListener('abort', cancel);
        current.current = null;
        setPending(null);
        resolve(choice);
      } };
      current.current = entry;
      request.signal.addEventListener('abort', cancel, { once: true });
      setPending(entry);
    });
  }, [browseOrigin]);
  return { pick, body: pending ? <ExecutableParticipantPickerBody {...pending.request} onResolve={pending.resolve} backRef={attachEntry} /> : null };
}
