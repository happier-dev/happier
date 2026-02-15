/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useVoiceSessionSnapshot (react-dom)', () => {
  it('does not log getSnapshot caching errors under react-dom StrictMode', async () => {
    vi.resetModules();

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { useVoiceSessionSnapshot } = await import('./voiceSession');

      function Test() {
        useVoiceSessionSnapshot();
        return React.createElement('div');
      }

      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      await act(async () => {
        root.render(React.createElement(React.StrictMode, null, React.createElement(Test)));
      });

      await act(async () => {
        root.render(React.createElement(React.StrictMode, null, React.createElement(Test)));
      });

      await act(async () => {
        root.unmount();
      });

      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
