import { describe, expect, it } from 'vitest';
import { systemPrompt } from './systemPrompt';

describe('systemPrompt', () => {
    it('documents inline @path workspace file references', () => {
        expect(systemPrompt).toContain('Linked workspace files');
        expect(systemPrompt).toContain('`@path`');
        expect(systemPrompt).toContain('Read tool');
    });

    it('instructs the agent to set a session title via change_title', () => {
        expect(systemPrompt).toContain('change_title');
    });
});
