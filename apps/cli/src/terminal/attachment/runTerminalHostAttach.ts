import type { TerminalAttachmentInfo } from './terminalAttachmentInfo';
import type { runZellijAttach } from './zellijAttach';
import type { runHerdrAttach } from './herdrAttach';
import type { runPtyAttach } from './ptyAttach';

type Terminal = NonNullable<TerminalAttachmentInfo['terminal']>;
type RunTmuxAttach = (params: Readonly<{
  sessionId: string;
  terminal: Terminal;
  refreshRemoteControl?: boolean;
}>) => Promise<number>;

export type TerminalHostAttachRunners = Readonly<{
  runTmuxAttachFn: RunTmuxAttach;
  runZellijAttachFn: typeof runZellijAttach;
  runHerdrAttachFn: typeof runHerdrAttach;
  runPtyAttachFn: typeof runPtyAttach;
}>;

/** The one dispatch for local terminal-host attachment, including foreground startup. */
export async function runTerminalHostAttach(
  params: Readonly<{ sessionId: string; terminal: Terminal; refreshRemoteControl?: boolean }>,
  runners: TerminalHostAttachRunners,
): Promise<number | null> {
  if (params.terminal.mode === 'tmux') {
    return await runners.runTmuxAttachFn({
      sessionId: params.sessionId,
      terminal: params.terminal,
      ...(params.refreshRemoteControl ? { refreshRemoteControl: true } : {}),
    });
  }
  if (params.terminal.mode === 'zellij') {
    return await runners.runZellijAttachFn({
      sessionId: params.sessionId,
      terminal: params.terminal,
    });
  }
  if (params.terminal.mode === 'herdr') {
    return await runners.runHerdrAttachFn({ terminal: params.terminal });
  }
  // The Session's Agent terminal on the PTY host, through the process holding the Session.
  if (params.terminal.mode === 'pty') {
    return await runners.runPtyAttachFn({ sessionId: params.sessionId });
  }
  return null;
}
