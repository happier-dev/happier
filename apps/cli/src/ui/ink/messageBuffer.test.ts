import { describe, expect, it, vi } from 'vitest';

import { MessageBuffer } from './messageBuffer';

describe('MessageBuffer', () => {
    it('retains only a bounded tail of messages', () => {
        const buffer = new MessageBuffer();

        for (let index = 0; index < 600; index += 1) {
            buffer.addMessage(`message ${index}`, 'assistant');
        }

        const messages = buffer.getMessages();
        expect(messages).toHaveLength(500);
        expect(messages[0]?.content).toBe('message 100');
        expect(messages.at(-1)?.content).toBe('message 599');
    });

    it('does not clone the message list on updates when there are no listeners', () => {
        const buffer = new MessageBuffer();
        const getMessagesSpy = vi.spyOn(buffer, 'getMessages');

        buffer.addMessage('unobserved', 'assistant');
        expect(getMessagesSpy).not.toHaveBeenCalled();

        const listener = vi.fn();
        const unsubscribe = buffer.onUpdate(listener);
        buffer.addMessage('observed', 'assistant');

        expect(getMessagesSpy).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledWith(expect.arrayContaining([
            expect.objectContaining({ content: 'observed' }),
        ]));

        unsubscribe();
    });
});
