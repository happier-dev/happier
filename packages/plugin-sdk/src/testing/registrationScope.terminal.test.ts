import { describe, expect, it, vi } from 'vitest';

import type { AgentTerminalSurface } from '../agentRuntime/index.js';
import type { AgentRuntimeFactory } from '../agentRuntime/index.js';
import { createPluginRegistrationScope } from '../registration/scope.js';

const factory = (async () => ({
    sessions: {
        open: async () => { throw new Error('not invoked'); },
    },
})) as AgentRuntimeFactory;

function scope(requiredFields: readonly ('terminal' | 'factory')[] = ['terminal']) {
    return createPluginRegistrationScope({
        pluginId: 'acme.terminal',
        target: { realm: 'daemon' },
        rights: [{ family: 'agents', localId: 'assistant', target: { realm: 'daemon' }, requiredFields }],
    });
}

describe('Agent terminal registration staging', () => {
    it('captures and binds the terminal launch resolver at commit', async () => {
        const committedResolver = vi.fn(function (this: { executable: string }) {
            return { argv: [this.executable] };
        });
        const terminal = {
            executable: 'fixture-terminal',
            resolveLaunch: committedResolver,
        } satisfies AgentTerminalSurface & { executable: string };
        const registrationScope = scope();
        registrationScope.api.agents.registerTerminal('assistant', terminal);
        const [registration] = registrationScope.commit();
        if (registration?.family !== 'agents' || !registration.value.terminal) {
            throw new Error('Expected committed Agent terminal contribution');
        }
        terminal.resolveLaunch = vi.fn(() => ({ argv: ['replacement'] }));

        expect(await registration.value.terminal.resolveLaunch({} as never))
            .toEqual({ argv: ['fixture-terminal'] });
        expect(Object.isFrozen(registration.value.terminal)).toBe(true);
        expect(committedResolver).toHaveBeenCalledOnce();
    });

    it('rejects duplicate terminal ownership for one Agent registration', () => {
        const registrationScope = scope();
        const terminal: AgentTerminalSurface = { resolveLaunch: () => ({ argv: ['fixture'] }) };
        registrationScope.api.agents.registerTerminal('assistant', terminal);

        expect(() => registrationScope.api.agents.registerTerminal('assistant', terminal))
            .toThrow(/duplicate Agent terminal contribution/iu);
    });

    it('enforces the declared terminal registration right at commit', () => {
        const missingTerminal = scope(['factory', 'terminal']);
        missingTerminal.api.agents.register('assistant', factory);
        expect(() => missingTerminal.commit()).toThrow(/missing Agent terminal contribution/iu);

        const undeclaredScope = scope([]);
        undeclaredScope.api.agents.registerTerminal('assistant', {
            resolveLaunch: () => ({ argv: ['fixture'] }),
        });
        expect(() => undeclaredScope.commit()).toThrow(/undeclared Agent terminal contribution/iu);
    });
});
