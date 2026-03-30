import { describe, expect, it } from 'vitest';

import { buildReadyNotificationContent } from './readyNotificationContent.js';

describe('buildReadyNotificationContent', () => {
  it('uses the session title and assistant preview when enabled', () => {
    expect(buildReadyNotificationContent({
      sessionTitle: 'Review branch',
      defaultTitle: 'Qwen Code',
      waitingForCommandLabel: 'Qwen Code',
      fallbackBody: 'Qwen Code is waiting for your command',
      includeMessageText: true,
      messageText: 'The branch is ready to review.',
    })).toEqual({
      title: 'Review branch',
      body: 'The branch is ready to review.',
    });
  });

  it('falls back to the waiting body when previews are disabled or empty', () => {
    expect(buildReadyNotificationContent({
      sessionTitle: 'Review branch',
      defaultTitle: 'Qwen Code',
      waitingForCommandLabel: 'Qwen Code',
      fallbackBody: 'Qwen Code is waiting for your command',
      includeMessageText: false,
      messageText: 'The branch is ready to review.',
    })).toEqual({
      title: 'Review branch',
      body: 'Qwen Code is waiting for your command',
    });

    expect(buildReadyNotificationContent({
      sessionTitle: '   ',
      defaultTitle: 'Qwen Code',
      waitingForCommandLabel: 'Qwen Code',
      fallbackBody: 'Qwen Code is waiting for your command',
      includeMessageText: true,
      messageText: '   ',
    })).toEqual({
      title: 'Qwen Code',
      body: 'Qwen Code is waiting for your command',
    });
  });
});
