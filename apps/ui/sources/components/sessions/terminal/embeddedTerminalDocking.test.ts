import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

describe('embeddedTerminalDocking', () => {
    it('creates an explicitly keyed details terminal tab when a terminal instance id is provided', async () => {
        const { createSessionDetailsTerminalTab } = await import('./embeddedTerminalDocking');

        expect(createSessionDetailsTerminalTab({ terminalInstanceId: 'term-2' })).toEqual({
            key: 'terminal:term-2',
            kind: 'terminal',
            title: 'settings.terminal',
            resource: { kind: 'terminal', terminalInstanceId: 'term-2', cwd: null },
        });
    });


});
