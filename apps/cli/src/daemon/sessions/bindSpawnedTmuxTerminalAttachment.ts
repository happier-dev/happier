import { buildTerminalAttachmentMetadataFromHostHandle } from '@/agent/runtime/terminal/attachmentMetadata';
import { createTmuxTerminalHostHandle } from '@/integrations/tmux/hostHandle';
import {
  createTerminalAttachmentId,
  writeTerminalAttachmentInfo,
} from '@/terminal/attachment/terminalAttachmentInfo';

export async function bindSpawnedTmuxTerminalAttachment(params: Readonly<{
  happyHomeDir: string;
  sessionId: string;
  tmuxSessionName: string;
  tmuxWindowName: string;
  tmuxTmpDir?: string;
  disposeUnboundHost: () => Promise<void>;
}>): Promise<void> {
  const attachmentId = createTerminalAttachmentId();
  const handle = createTmuxTerminalHostHandle({
    attachmentId,
    sessionName: params.tmuxSessionName,
    windowName: params.tmuxWindowName,
    tmuxTmpDir: params.tmuxTmpDir,
    topology: 'shared',
  });
  const terminal = buildTerminalAttachmentMetadataFromHostHandle(handle);
  if (!terminal) throw new Error('Failed to build tmux terminal attachment metadata');
  try {
    await writeTerminalAttachmentInfo({
      happyHomeDir: params.happyHomeDir,
      sessionId: params.sessionId,
      attachmentId,
      handle,
      terminal,
    });
  } catch (bindingError) {
    try {
      await params.disposeUnboundHost();
    } catch (disposalError) {
      throw new AggregateError(
        [bindingError, disposalError],
        'Failed to bind and dispose an unbound tmux terminal host',
      );
    }
    throw bindingError;
  }
}
