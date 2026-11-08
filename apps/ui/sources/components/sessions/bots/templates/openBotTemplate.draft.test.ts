import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotTemplateActionInputSchemasV1 } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { requestBotTemplateDraft } from './openBotTemplate';

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
afterEach(standardCleanup);

describe('Give a copy…', () => {
    // REAL-USER-PASS F7: it sent the person's own chat message naming `template.draft` and opened nothing.
    it('drafts the template from this Bot through template.draft and opens that draft, never as a chat message', async () => {
        const session = createSessionFixture({ id: 'garden-bot', serverId: 'home', metadata: { path: '/garden', host: 'home', name: 'Garden keeper', flavor: 'codex',
            bot: { kind: 'bot' }, botFace: { seed: 'garden-seed' },
            work: { promptStack: [{ id: 'session.instructions', ref: { kind: 'doc', artifactId: 'garden-instructions' },
                enabled: true, required: true, placement: 'system_append' }] } } as never });
        const calls: Array<Readonly<{ actionId: string; input: unknown }>> = [];
        // The mounted Action executor is the boundary: each call is a real Action request with its own result.
        const execute = vi.fn(async (actionId: string, input: unknown) => {
            calls.push({ actionId, input });
            if (actionId === 'prompt_doc.get') return { ok: true as const, result: { ok: true, artifactId: 'garden-instructions',
                title: 'Garden keeper instructions', markdown: '# Garden\n\nWater herbs.', revision: { bodyVersion: 1, headerVersion: 1 } } };
            if (actionId === 'template.draft') return { ok: true as const, result: { draftArtifactId: '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f', revision: { bodyVersion: 1, headerVersion: 1 },
                sourceSessionRef: { serverId: 'home', sessionId: 'garden-bot' }, summary: { identity: { name: 'Garden keeper', description: '' },
                    includes: { memoryRules: 0, skills: 0, software: 0, connectedAccounts: 0, mcpServers: 0 }, leftOut: { memoryRules: 0, skills: 0 } } } };
            return { ok: true as const, result: { opened: true } };
        });
        const result = await requestBotTemplateDraft(execute as never, session, 'home');
        expect(result).toMatchObject({ ok: true });
        expect(calls.map(call => call.actionId)).not.toContain('session.message.send');
        const draft = calls.find(call => call.actionId === 'template.draft');
        const input = BotTemplateActionInputSchemasV1['template.draft'].parse(draft?.input);
        expect(input.sourceSessionRef).toEqual({ serverId: 'home', sessionId: 'garden-bot' });
        expect(input.content.identity).toMatchObject({ name: 'Garden keeper', face: { seed: 'garden-seed' } });
        expect(input.content.instructions.markdown).toBe('# Garden\n\nWater herbs.');
        // REAL-USER-PASS-2 G7: the editor started at "Choose…" although the Bot runs Codex.
        expect(input.content.suggestedAgent).toEqual({ agentId: 'codex' });
        expect(calls.at(-1)).toEqual({ actionId: 'template.open', input: { draftArtifactId: '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f',
            sourceSessionRef: { serverId: 'home', sessionId: 'garden-bot' }, presentation: 'pane' } });
    });
});
