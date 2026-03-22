import React from 'react';
import { render } from 'ink';

import { cleanupStdinAfterInk } from '@/ui/ink/cleanupStdinAfterInk';
import { createNonBlockingStdout } from '@/ui/ink/nonBlockingStdout';
import { restoreStdinBestEffort } from '@/ui/ink/restoreStdinBestEffort';
import { SessionActionSelector, type SessionActionSelectorRow } from './SessionActionSelector';

type InkInstance = {
  unmount: () => void;
};

function hasSetRawMode(stream: NodeJS.ReadStream): stream is NodeJS.ReadStream & { setRawMode: (mode: boolean) => void } {
  return typeof (stream as { setRawMode?: unknown }).setRawMode === 'function';
}

export function canUseInkSelector(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && hasSetRawMode(process.stdin));
}

export async function runSessionActionSelector(params: Readonly<{
  title: string;
  actionVerb: string;
  footerHint?: string | null;
  rows: ReadonlyArray<SessionActionSelectorRow>;
  onProbe?: (sessionId: string) => Promise<{ reachable: boolean; reason?: string }>;
}>): Promise<{ type: 'selected'; sessionId: string } | { type: 'cancelled' }> {
  let inkInstance: InkInstance | null = null;
  let resolveSelection: ((value: { type: 'selected'; sessionId: string } | { type: 'cancelled' }) => void) | null = null;
  const selectionPromise = new Promise<{ type: 'selected'; sessionId: string } | { type: 'cancelled' }>((resolve) => {
    resolveSelection = resolve;
  });

  try {
    console.clear();
    inkInstance = render(
      React.createElement(SessionActionSelector, {
        title: params.title,
        actionVerb: params.actionVerb,
        footerHint: params.footerHint ?? null,
        rows: params.rows,
        onProbe: params.onProbe,
        onSelect: (sessionId) => resolveSelection?.({ type: 'selected', sessionId }),
        onCancel: () => resolveSelection?.({ type: 'cancelled' }),
      }),
      {
        exitOnCtrlC: false,
        patchConsole: false,
        stdout: createNonBlockingStdout(process.stdout),
      },
    );

    process.stdin.resume();
    if (process.stdin.isTTY && hasSetRawMode(process.stdin)) {
      process.stdin.setRawMode(true);
    }
    process.stdin.setEncoding('utf8');

    return await selectionPromise;
  } finally {
    try {
      inkInstance?.unmount();
    } catch {
      // ignore
    }
    await cleanupStdinAfterInk({ stdin: process.stdin, drainMs: 75 });
    restoreStdinBestEffort({ stdin: process.stdin });
  }
}
