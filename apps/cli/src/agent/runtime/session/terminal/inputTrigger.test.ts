import { describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';

import { createTerminalRuntimeInputTriggerService } from './inputTrigger';

describe('createTerminalRuntimeInputTriggerService', () => {
    it('publishes sanitized trigger notifications without queued prompt content', () => {
        const queue = new MessageQueue2<{ permissionMode: string }, { text: string }>((mode) => mode.permissionMode);
        const service = createTerminalRuntimeInputTriggerService({ messageQueue: queue });
        const received: unknown[] = [];

        const subscription = service.subscribe((trigger) => {
            received.push(trigger);
        });

        queue.push({ text: 'do not expose this prompt' }, { permissionMode: 'default' });
        expect(received).toEqual([{ sequence: 1 }]);
        expect(JSON.stringify(received)).not.toContain('do not expose this prompt');

        subscription.unsubscribe();
        queue.push({ text: 'after unsubscribe' }, { permissionMode: 'default' });
        expect(received).toEqual([{ sequence: 1 }]);
    });

    it('isolates subscriber failures from message queue push and other subscribers', () => {
        const queue = new MessageQueue2<{ permissionMode: string }, { text: string }>((mode) => mode.permissionMode);
        const service = createTerminalRuntimeInputTriggerService({ messageQueue: queue });
        const failingSubscriber = vi.fn(() => {
            throw new Error('subscriber failed');
        });
        const receivingSubscriber = vi.fn();

        service.subscribe(failingSubscriber);
        service.subscribe(receivingSubscriber);

        expect(() => queue.push({ text: 'trigger remote switch' }, { permissionMode: 'default' })).not.toThrow();
        expect(failingSubscriber).toHaveBeenCalledWith({ sequence: 1 });
        expect(receivingSubscriber).toHaveBeenCalledWith({ sequence: 1 });
    });
});
