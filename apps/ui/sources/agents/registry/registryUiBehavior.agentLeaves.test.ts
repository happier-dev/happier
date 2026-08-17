import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const registryUiBehaviorSource = readFileSync(new URL('./registryUiBehavior.ts', import.meta.url), 'utf8');
const descriptorSource = readFileSync(new URL('./agentUiBehaviorDescriptors.ts', import.meta.url), 'utf8');
const generatedOverridesSource = readFileSync(
    new URL('./generatedBundledPluginEntries.uiBehaviorOverrides.ts', import.meta.url),
    'utf8',
);

describe('agent UI behavior provider leaf ownership', () => {
    it('keeps provider override leaves out of the generic registry', () => {
        expect(registryUiBehaviorSource).not.toMatch(/agentUiBehavior\/(?:claude|codex|pi)/u);
        expect(registryUiBehaviorSource).not.toContain('FIRST_PARTY_AGENT_UI_BEHAVIOR_OVERRIDE_CONTRIBUTIONS');
        expect(registryUiBehaviorSource).not.toContain('resolveFirstPartyAgentUiBehaviorOverride');
        expect(registryUiBehaviorSource).not.toContain('resolveProviderSessionArtifactPath');
    });

    it('uses plugin-owned UI behavior overrides through the generated contribution map', () => {
        expect(generatedOverridesSource).toMatch(/@happier-dev\/plugins-auggie\/ui/u);
        expect(generatedOverridesSource).toMatch(/@happier-dev\/plugins-claude\/ui/u);
        expect(generatedOverridesSource).toMatch(/@happier-dev\/plugins-codex\/ui/u);
        expect(generatedOverridesSource).not.toMatch(/@happier-dev\/plugins-pi\/ui\/behavior/u);
        expect(generatedOverridesSource).toMatch(/auggie:\s*AUGGIE_UI_BEHAVIOR_OVERRIDE/u);
        expect(generatedOverridesSource).toMatch(/claude:\s*CLAUDE_UI_BEHAVIOR_OVERRIDE/u);
        expect(generatedOverridesSource).toMatch(/codex:\s*CODEX_UI_BEHAVIOR_OVERRIDE/u);
        expect(generatedOverridesSource).not.toContain('PI_UI_BEHAVIOR_OVERRIDE');
    });

    it('does not special-case provider descriptor ids in the generic descriptor adapter', () => {
        expect(descriptorSource).not.toContain('auggie.uiBehavior.v1');
        expect(descriptorSource).not.toContain('pi.uiBehavior.v1');
        expect(descriptorSource).not.toContain('createAuggieUiBehavior');
    });
});
