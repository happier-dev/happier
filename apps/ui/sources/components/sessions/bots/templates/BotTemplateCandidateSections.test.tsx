import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotTemplateDraftV1Schema, projectBotTemplateContentV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { BotTemplateMemorySection, BotTemplateSkillsSection } from './BotTemplateCandidateSections';
import { createBotTemplateEditorBuffer, type BotTemplateSave } from './botTemplateEditorBuffer';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(standardCleanup);

describe('template candidate authoring', () => {
    it.each([0, 1, 3])('folds %i personal facts into one closed summary without rendering their contents', async count => {
        const personal = Array.from({ length: count }, (_, index) => ({ key: `personal-${index}`, text: `Sensitive detail ${index}`, personal: true }));
        const draft = BotTemplateDraftV1Schema.parse({ v: 1, state: 'draft', sourceSessionRef: { serverId: 'home', sessionId: 'bot' },
            releaseArtifactId: '32c55218-6b01-40ef-8237-e53dc6de68d3',
            content: { v: 1, identity: { name: 'Review', description: '' }, instructions: { markdown: '' }, memoryRules: [], skills: [],
                needs: { software: [], connectedAccounts: [], mcpServers: [] } },
            candidates: { memoryRules: [...personal, { key: 'rule', text: 'Review changed files' }], skills: [] } });
        const buffer = createBotTemplateEditorBuffer({ draft, revision: { headerVersion: 1, bodyVersion: 1 } });
        const save = vi.fn<BotTemplateSave>(async () => ({ ok: true, revision: { headerVersion: 2, bodyVersion: 2 } }));
        const screen = await renderScreen(<BotTemplateMemorySection buffer={buffer} save={save} />, {
            wrapper: ({ children }) => <ListPresentationProvider value="page">{children}</ListPresentationProvider>,
        });
        expect(screen.findAllHostsByTestId('bot-template-personal-facts')).toHaveLength(count ? 1 : 0);
        const rendered = screen.getTextContent();
        for (const fact of personal) {
            expect(rendered).not.toContain(fact.text);
            expect(screen.findByTestId(`bot-template-memory:${fact.key}`)).toBeNull();
        }
        expect(screen.findByTestId('bot-template-memory:rule')).not.toBeNull();
        expect(save).not.toHaveBeenCalled();
        expect(projectBotTemplateContentV1(buffer.getSnapshot().draft).memoryRules).toEqual([]);
        if (count) {
            expect(rendered).toContain(`${count} ${count === 1 ? 'fact' : 'facts'} about you`);
            expect(rendered).toContain('Left out');
            await screen.pressByTestIdAsync('bot-template-personal-facts');
            for (const fact of personal) expect(screen.findByTestId(`bot-template-memory:${fact.key}`)?.props.value).toBe(false);
            await act(async () => { screen.findByTestId('bot-template-memory:personal-0')?.props.onValueChange(true); });
            expect(projectBotTemplateContentV1(buffer.getSnapshot().draft).memoryRules).toEqual([{ key: 'personal-0', text: 'Sensitive detail 0' }]);
            expect(draft.candidates.memoryRules[0]?.selected).toBe(false);
            expect(save).toHaveBeenCalledTimes(1);
            expect(screen.getTextContent()).not.toContain('Left out');
            await screen.pressByTestIdAsync('bot-template-personal-facts');
            for (const fact of personal) expect(screen.getTextContent()).not.toContain(fact.text);
        }
    });

    it('commits selected memory and inline general copies through the draft save boundary while excluding private facts and retaining source files', async () => {
        const sourceText = '---\nname: review\ndescription: Review work\n---\nPrivate instructions';
        const draft = BotTemplateDraftV1Schema.parse({ v: 1, state: 'draft', sourceSessionRef: { serverId: 'home', sessionId: 'bot' },
            releaseArtifactId: '32c55218-6b01-40ef-8237-e53dc6de68d3',
            content: { v: 1, identity: { name: 'Review', description: '' }, instructions: { markdown: '' }, memoryRules: [], skills: [],
                needs: { software: [], connectedAccounts: [], mcpServers: [] } },
            candidates: { memoryRules: [{ key: 'personal', text: 'Private address', personal: true }, { key: 'rule', text: 'Review changed files' }],
                skills: [{ key: 'skill', title: 'Review', bundleSchemaId: 'skills.skill_md_v1', selection: 'private',
                    entries: [{ path: 'SKILL.md', contentKind: 'utf8', contentBase64: encodeBase64(new TextEncoder().encode(sourceText)) },
                        { path: 'example.bin', contentKind: 'binary', contentBase64: 'AP8B' }] }] } });
        const buffer = createBotTemplateEditorBuffer({ draft, revision: { headerVersion: 1, bodyVersion: 1 } });
        const save = vi.fn<BotTemplateSave>(async () => ({ ok: true, revision: { headerVersion: 2, bodyVersion: 2 } }));
        let memoryRenders = 0;
        const screen = await renderScreen(<><React.Profiler id="memory" onRender={() => { memoryRenders += 1; }}>
            <BotTemplateMemorySection buffer={buffer} save={save} /></React.Profiler><BotTemplateSkillsSection buffer={buffer} save={save} /></>, {
            wrapper: ({ children }) => <ListPresentationProvider value="page">{children}</ListPresentationProvider>,
        });
        expect(projectBotTemplateContentV1(buffer.getSnapshot().draft)).toMatchObject({ memoryRules: [], skills: [] });
        await act(async () => { screen.findByTestId('bot-template-memory:rule')?.props.onValueChange(true); });
        await screen.pressByTestIdAsync('bot-template-skill:skill:general_copy');
        const memoryRendersBeforeFileEdit = memoryRenders;
        const text = '---\nname: review\ndescription: Review work\n---\nReusable instructions';
        await act(async () => { screen.changeTextByTestId('bot-template-skill-file:skill:SKILL.md', text); });
        await act(async () => { screen.findByTestId('bot-template-skill-file:skill:SKILL.md')?.props.onBlur(); });
        expect(memoryRenders - memoryRendersBeforeFileEdit).toBe(0);
        expect(save.mock.calls.at(-1)?.[0].draft.candidates.skills[0]?.generalCopy?.entries[0]?.contentBase64)
            .toBe(encodeBase64(new TextEncoder().encode(text)));
        const projected = projectBotTemplateContentV1(buffer.getSnapshot().draft);
        expect(projected.memoryRules).toEqual([{ key: 'rule', text: 'Review changed files' }]);
        expect(projected.skills[0]?.entries[1]).toEqual(draft.candidates.skills[0]?.entries[1]);
        expect(draft.candidates.skills[0]?.entries[0]?.contentBase64).toBe(encodeBase64(new TextEncoder().encode(sourceText)));
        await screen.pressByTestIdAsync('bot-template-skill:skill:private');
        expect(projectBotTemplateContentV1(buffer.getSnapshot().draft).skills).toEqual([]);
    });
});
