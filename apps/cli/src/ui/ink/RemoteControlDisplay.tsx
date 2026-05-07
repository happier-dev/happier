import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';

import { MessageBuffer, type BufferedMessage } from '@/ui/ink/messageBuffer';
import {
  createRemoteModeControlController,
  interpretRemoteModeKeypress,
  type RemoteModeActionInProgress,
  type RemoteModeConfirmation,
  type RemoteModeControlController,
  type RemoteModeKeypressAction,
} from '@/ui/remoteControl/remoteModeControl';

export { interpretRemoteModeKeypress };
export type { RemoteModeActionInProgress, RemoteModeConfirmation, RemoteModeKeypressAction };

export type RemoteControlDisplayProps = {
  providerName: string;
  messageBuffer: MessageBuffer;
  logPath?: string;
  allowSwitchToLocal?: boolean;
  onExit?: () => void | Promise<void>;
  onSwitchToLocal?: () => void | Promise<void>;
};

export const RemoteControlDisplay: React.FC<RemoteControlDisplayProps> = ({
  providerName,
  messageBuffer,
  logPath,
  allowSwitchToLocal,
  onExit,
  onSwitchToLocal,
}) => {
  const [messages, setMessages] = useState<BufferedMessage[]>([]);
  const [confirmationMode, setConfirmationMode] = useState<RemoteModeConfirmation>(null);
  const [actionInProgress, setActionInProgress] = useState<RemoteModeActionInProgress>(null);
  const controllerRef = useRef<RemoteModeControlController | null>(null);
  const { stdout } = useStdout();
  const terminalWidth = stdout.columns || 80;
  const terminalHeight = stdout.rows || 24;

  const switchEnabled = allowSwitchToLocal === true && typeof onSwitchToLocal === 'function';

  useEffect(() => {
    setMessages(messageBuffer.getMessages());

    const unsubscribe = messageBuffer.onUpdate((newMessages) => {
      setMessages(newMessages);
    });

    return () => {
      unsubscribe();
    };
  }, [messageBuffer]);

  useEffect(() => {
    const controller = createRemoteModeControlController({
      allowSwitchToLocal: switchEnabled,
      onExit,
      onSwitchToLocal,
      onStateChange: (snapshot) => {
        setConfirmationMode(snapshot.confirmationMode);
        setActionInProgress(snapshot.actionInProgress);
      },
    });
    controllerRef.current = controller;
    const snapshot = controller.getSnapshot();
    setConfirmationMode(snapshot.confirmationMode);
    setActionInProgress(snapshot.actionInProgress);

    return () => {
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [switchEnabled, onExit, onSwitchToLocal]);

  useInput(
    useCallback(
      (input, key) => {
        controllerRef.current?.handleKeypress(input, key);
      },
      [],
    ),
  );

  const getMessageColor = (type: BufferedMessage['type']): string => {
    switch (type) {
      case 'user':
        return 'magenta';
      case 'assistant':
        return 'cyan';
      case 'system':
        return 'blue';
      case 'tool':
        return 'yellow';
      case 'result':
        return 'green';
      case 'status':
        return 'gray';
      default:
        return 'white';
    }
  };

  const formatMessage = (msg: BufferedMessage): string => {
    const lines = msg.content.split('\n');
    const maxLineLength = terminalWidth - 10;
    return lines
      .map((line) => {
        if (line.length <= maxLineLength) return line;
        const chunks: string[] = [];
        for (let i = 0; i < line.length; i += maxLineLength) {
          chunks.push(line.slice(i, i + maxLineLength));
        }
        return chunks.join('\n');
      })
      .join('\n');
  };

  return (
    <Box flexDirection="column" width={terminalWidth} height={terminalHeight}>
      <Box
        flexDirection="column"
        width={terminalWidth}
        height={terminalHeight - 4}
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        overflow="hidden"
      >
        <Box flexDirection="column" marginBottom={1}>
          <Text color="gray" bold>
            {`📡 Remote Mode - ${providerName} Messages`}
          </Text>
          <Text color="gray" dimColor>
            {'─'.repeat(Math.min(terminalWidth - 4, 60))}
          </Text>
        </Box>

        <Box flexDirection="column" height={terminalHeight - 10} overflow="hidden">
          {messages.length === 0 ? (
            <Text color="gray" dimColor>
              Waiting for messages...
            </Text>
          ) : (
            messages.slice(-Math.max(1, terminalHeight - 10)).map((msg) => (
              <Box key={msg.id} flexDirection="column" marginBottom={1}>
                <Text color={getMessageColor(msg.type)} dimColor>
                  {formatMessage(msg)}
                </Text>
              </Box>
            ))
          )}
        </Box>
      </Box>

      <Box
        width={terminalWidth}
        borderStyle="round"
        borderColor={
          actionInProgress ? 'gray' : confirmationMode === 'exit' ? 'red' : confirmationMode === 'switch' ? 'yellow' : 'green'
        }
        paddingX={2}
        justifyContent="center"
        alignItems="center"
        flexDirection="column"
      >
        <Box flexDirection="column" alignItems="center">
          {actionInProgress === 'exiting' ? (
            <Text color="gray" bold>
              Exiting...
            </Text>
          ) : actionInProgress === 'switching' ? (
            <Text color="gray" bold>
              Switching to local mode...
            </Text>
          ) : confirmationMode === 'exit' ? (
            <Text color="red" bold>
              ⚠️ Press Ctrl-C again to exit completely
            </Text>
          ) : confirmationMode === 'switch' ? (
            <Text color="yellow" bold>
              ⏸️ Press space again (or Ctrl-T) to switch to local mode
            </Text>
          ) : switchEnabled ? (
            <Text color="green" bold>
              📱 Press space (or Ctrl-T) to switch to local mode • Ctrl-C to exit
            </Text>
          ) : (
            <Text color="green" bold>
              {`${providerName} remote mode • Ctrl-C to exit`}
            </Text>
          )}
          {process.env.DEBUG && logPath && (
            <Text color="gray" dimColor>
              Debug logs: {logPath}
            </Text>
          )}
        </Box>
      </Box>
    </Box>
  );
};
