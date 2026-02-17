import { describe, expect, it } from 'vitest';
import { normalizeRawMessage } from './normalize';

describe('typesRaw.normalizeRawMessage (task-notification)', () => {
  it('drops Claude Code <task-notification> user-text messages from the main transcript', () => {
    const raw: any = {
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'user',
          uuid: 'uuid_task_note_1',
          parentUuid: null,
          isSidechain: false,
          message: {
            role: 'user',
            content:
              '<task-notification>\n' +
              '<task-id>a971610</task-id>\n' +
              '<status>completed</status>\n' +
              '<summary>done</summary>\n' +
              '<result>Hello</result>\n' +
              '</task-notification>',
          },
        },
      },
      meta: { source: 'cli' },
    };

    const normalized = normalizeRawMessage('msg_task_note_1', null, 1000, raw, { seq: 5 });
    expect(normalized).toBeNull();
  });

  it('keeps regular user text messages', () => {
    const raw: any = {
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'user',
          uuid: 'uuid_user_1',
          parentUuid: null,
          isSidechain: false,
          message: { role: 'user', content: 'hello' },
        },
      },
      meta: { source: 'cli' },
    };

    const normalized = normalizeRawMessage('msg_user_1', null, 1001, raw, { seq: 7 });
    expect(normalized).not.toBeNull();
    expect((normalized as any).seq).toBe(7);
    expect((normalized as any)?.role).toBe('user');
  });
});
