import { render } from 'ink';
import React from 'react';

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createNonBlockingStdout } from '@/ui/ink/nonBlockingStdout';
import { GeminiTerminalDisplay } from '@/backends/gemini/ui/GeminiTerminalDisplay';

export function createGeminiTerminalUi(params: {
  messageBuffer: MessageBuffer;
  hasTTY: boolean;
  stdin: NodeJS.ReadStream;
  logPath?: string;
  initialModel?: string;
  onExit: () => Promise<void>;
  onDebug: (message: string) => void;
  saveModelToConfig: (model: string) => void;
}) {
  let inkInstance: ReturnType<typeof render> | null = null;
  let displayedModel: string | undefined = params.initialModel;

  const updateDisplayedModel = (model: string | undefined, saveToConfig: boolean = false) => {
    if (model === undefined) {
      params.onDebug('[gemini] updateDisplayedModel called with undefined, skipping update');
      return;
    }

    const oldModel = displayedModel;
    displayedModel = model;
    params.onDebug(`[gemini] updateDisplayedModel called: oldModel=${oldModel}, newModel=${model}, saveToConfig=${saveToConfig}`);

    if (saveToConfig) {
      params.saveModelToConfig(model);
    }

    if (params.hasTTY && oldModel !== model) {
      params.onDebug(`[gemini] Adding model update message to buffer: [MODEL:${model}]`);
      params.messageBuffer.addMessage(`[MODEL:${model}]`, 'system');
    } else if (params.hasTTY) {
      params.onDebug('[gemini] Model unchanged, skipping update message');
    }
  };

  const mount = () => {
    if (!params.hasTTY) return;

    console.clear();

    const DisplayComponent = () => {
      const currentModelValue = displayedModel || 'gemini-2.5-pro';
      return React.createElement(GeminiTerminalDisplay, {
        messageBuffer: params.messageBuffer,
        logPath: params.logPath,
        currentModel: currentModelValue,
        onExit: params.onExit,
      });
    };

    inkInstance = render(React.createElement(DisplayComponent), {
      exitOnCtrlC: false,
      patchConsole: false,
      stdout: createNonBlockingStdout(process.stdout as any),
    });

    const initialModelName = displayedModel || 'gemini-2.5-pro';
    params.onDebug(`[gemini] Sending initial model to UI: ${initialModelName}`);
    params.messageBuffer.addMessage(`[MODEL:${initialModelName}]`, 'system');

    params.stdin.resume();
    if (params.stdin.isTTY) {
      params.stdin.setRawMode(true);
    }
    params.stdin.setEncoding('utf8');
  };

  const unmount = async () => {
    if (params.stdin.isTTY) {
      try {
        params.stdin.setRawMode(false);
      } catch {
        // ignore
      }
    }
    if (params.hasTTY) {
      try {
        params.stdin.pause();
      } catch {
        // ignore
      }
    }
    if (inkInstance) {
      inkInstance.unmount();
      inkInstance = null;
    }
  };

  return {
    mount,
    unmount,
    updateDisplayedModel,
    getDisplayedModel: () => displayedModel,
  };
}
