import { describe, expect, it, vi } from 'vitest';

import { notifyComposerAttachmentsAfterMessageAccepted } from './notifyComposerAttachmentsAfterMessageAccepted';

describe('notifyComposerAttachmentsAfterMessageAccepted', () => {
  it('starts one best-effort notification with the accepted attachment values', async () => {
    const notify = vi.fn(async () => undefined);
    const signal = new AbortController().signal;

    notifyComposerAttachmentsAfterMessageAccepted({
      sessionId: 'session-1',
      localId: 'input-1',
      attachments: [{
        v: 1,
        instanceId: 'attachment-1',
        attachment: { pluginId: 'acme.issues', localId: 'issue' },
        key: '42',
        value: { issueId: 42 },
        presentation: { label: 'Issue #42', typeLabel: 'Issue' },
      }],
      notify,
      signal,
    });

    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify).toHaveBeenCalledWith({
      attachment: { pluginId: 'acme.issues', localId: 'issue' },
      event: {
        sessionId: 'session-1',
        localId: 'input-1',
        attachments: [{ instanceId: 'attachment-1', key: '42', value: { issueId: 42 } }],
      },
      signal,
    });
  });
});
