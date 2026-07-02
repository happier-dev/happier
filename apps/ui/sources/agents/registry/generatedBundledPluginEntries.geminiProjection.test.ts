import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('generated bundled agent UI projection', () => {
    it('uses plugin-authored generated facts instead of legacy UI provider imports', () => {
        const generatedPath = resolve(__dirname, 'generatedBundledPluginEntries.ts');
        const generated = readFileSync(generatedPath, 'utf8');

        expect(generated).not.toMatch(/@\/agents\/providers\/gemini\/core/);
        expect(generated).not.toMatch(/@\/agents\/providers\/gemini\/ui/);
        expect(generated).toMatch(/const GEMINI_CORE: AgentCoreConfig/);
        expect(generated).toMatch(/gemini:\s*GEMINI_CORE/);
        expect(generated).toMatch(/gemini:\s*GEMINI_UI/);
    });

    it('uses Kilo, Pi, and Copilot plugin descriptors instead of legacy UI provider imports', () => {
        const generatedPath = resolve(__dirname, 'generatedBundledPluginEntries.ts');
        const generated = readFileSync(generatedPath, 'utf8');

        for (const agentId of ['kilo', 'pi', 'copilot']) {
            expect(generated).not.toMatch(new RegExp(`@/agents/providers/${agentId}/core`));
            expect(generated).not.toMatch(new RegExp(`@/agents/providers/${agentId}/ui`));
        }
        expect(generated).toMatch(/const KILO_CORE: AgentCoreConfig/);
        expect(generated).toMatch(/const PI_CORE: AgentCoreConfig/);
        expect(generated).toMatch(/const COPILOT_CORE: AgentCoreConfig/);
        expect(generated).toMatch(/kilo:\s*KILO_CORE/);
        expect(generated).toMatch(/pi:\s*PI_CORE/);
        expect(generated).toMatch(/copilot:\s*COPILOT_CORE/);
    });
});
