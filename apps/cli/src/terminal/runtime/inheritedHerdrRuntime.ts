import { createHerdrClient } from '@/integrations/herdr/client';
import { HERDR_ACTION_TIMEOUT_MS, resolveHerdrRuntimeBinary } from '@/integrations/herdr/runtimeBinary';
import { createTerminalAttachmentId } from '@/terminal/attachment/terminalAttachmentInfo';

import type { TerminalRuntimeFlags } from './terminalRuntimeFlags';

export async function resolveInheritedHerdrRuntime(params: Readonly<{
  terminalRuntime: TerminalRuntimeFlags | null;
  env: NodeJS.ProcessEnv;
}>): Promise<TerminalRuntimeFlags | null> {
  if (params.terminalRuntime?.mode && params.terminalRuntime.mode !== 'herdr') {
    return params.terminalRuntime;
  }
  const socketPath = params.env.HERDR_SOCKET_PATH?.trim();
  const paneId = params.env.HERDR_PANE_ID?.trim();
  if (params.env.HERDR_ENV !== '1' || !socketPath || !paneId) {
    if (params.terminalRuntime?.mode === 'herdr') {
      throw new Error('Herdr terminal mode requires a live Herdr pane context');
    }
    return params.terminalRuntime;
  }

  const binary = await resolveHerdrRuntimeBinary({ actionTimeoutMs: HERDR_ACTION_TIMEOUT_MS, processEnv: params.env });
  if (!binary) throw new Error('A supported Herdr installation is required for this terminal session');
  const client = createHerdrClient({
    binary,
    sessionName: 'default',
    socketPath,
    actionTimeoutMs: HERDR_ACTION_TIMEOUT_MS,
    startupTimeoutMs: HERDR_ACTION_TIMEOUT_MS,
  });
  await client.assertServerVersion();
  let sessionName = params.terminalRuntime?.herdrSessionName?.trim();
  if (!sessionName) {
    // The successful snapshot above is the authoritative live-socket probe.
    // Inventory lookup is only required for a wrapper typed into an existing
    // Herdr pane, where no daemon launch owner could carry the session name.
    const session = (await client.listSessions()).find((item) => item.socketPath === socketPath);
    if (!session) throw new Error('The current Herdr session is unavailable');
    sessionName = session.name;
  }
  const pane = await client.getPane(paneId);
  const attachmentId = params.terminalRuntime?.attachmentId?.trim()
    || params.env.HAPPIER_TERMINAL_ATTACHMENT_ID?.trim()
    || createTerminalAttachmentId();
  // Happier owns the resume action for this pane. Native provider hooks must not
  // replace it with a provider-only resume command in managed descendants.
  delete params.env.HERDR_ENV;
  return {
    ...params.terminalRuntime,
    mode: 'herdr',
    requested: 'herdr',
    herdrSessionName: sessionName,
    herdrSocketPath: socketPath,
    herdrTerminalId: pane.terminalId,
    herdrPaneId: pane.paneId,
    attachmentId,
  };
}
