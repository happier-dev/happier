import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('foreground Voice text-turn QA bridge ownership', () => {
    it('delegates to the incumbent adapter and durable turn owner without reading foreground context or actions', async () => {
        const source = await readFile('sources/dev/testkit/harness/foregroundVoiceTextTurnQaBridge.ts', 'utf8');

        expect(source).toContain('submitDurableVoiceTextTurn');
        expect(source).toContain('adapter.sendTextTurn!');
        expect(source).toContain('resolveActiveLocalVoiceAgentBinding');
        expect(source).not.toContain('voiceConversationBindingResolver');
        expect(source).not.toContain('@/components/appShell');
        expect(source).not.toContain('@/voice/tools');
        expect(source).not.toMatch(/currentUiContext|runVoiceAgentTurnWithTools|readCurrentUiContext/u);
    });
});
