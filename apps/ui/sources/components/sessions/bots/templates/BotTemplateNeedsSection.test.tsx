import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotTemplateDraftV1Schema, projectBotTemplateContentV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { McpServerCatalogEntryV1Schema } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { projectBotTemplateMcpDefinitionV1 } from '@happier-dev/protocol/mcp/servers/portableMcpDefinitionV1';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { BotTemplateNeedsSection } from './BotTemplateNeedsSection';
import { createBotTemplateEditorBuffer, type BotTemplateSave } from './botTemplateEditorBuffer';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(standardCleanup);
const page = ({ children }: React.PropsWithChildren) => <ListPresentationProvider value="page">{children}</ListPresentationProvider>;

function opening() {
    return BotTemplateDraftV1Schema.parse({ v: 1, state: 'draft', sourceSessionRef: { serverId: 'home', sessionId: 'source' },
        releaseArtifactId: '32c55218-6b01-40ef-8237-e53dc6de68d3',
        content: { v: 1, identity: { name: 'Review', description: '' }, instructions: { markdown: '' }, memoryRules: [], skills: [],
            needs: { software: [{ key: 'runtime', name: 'Runtime', purpose: 'Run the tool', skipConsequence: 'The tool cannot run', requirement: 'required',
                recipe: { pluginId: 'example.tools', recipeId: 'runtime', revision: '1' } }], connectedAccounts: [], mcpServers: [] } },
        candidates: { memoryRules: [], skills: [] } });
}

describe('template needs authoring', () => {
    it('keeps existing recipe references editable without a source Machine catalog and commits requirement and purpose changes', async () => {
        const draft = opening();
        const buffer = createBotTemplateEditorBuffer({ draft, revision: { headerVersion: 1, bodyVersion: 1 } });
        const save = vi.fn<BotTemplateSave>(async () => ({ ok: true, revision: { headerVersion: 2, bodyVersion: 2 } }));
        const screen = await renderScreen(<BotTemplateNeedsSection buffer={buffer} save={save} scope={{ serverId: 'home', accountId: 'author' }} />, { wrapper: page });
        await screen.pressByTestIdAsync('bot-template-need:software:runtime');
        await screen.pressByTestIdAsync('bot-template-need-requirement:runtime:optional');
        await act(async () => { screen.changeTextByTestId('bot-template-need-field:runtime:purpose', 'Run review helpers'); });
        await act(async () => { screen.findByTestId('bot-template-need-field:runtime:purpose')?.props.onBlur(); });
        expect(save.mock.calls.at(-1)?.[0].draft.content.needs.software[0]).toMatchObject({ requirement: 'optional', purpose: 'Run review helpers',
            recipe: draft.content.needs.software[0]?.recipe });
        expect(draft.content.needs.software[0]?.requirement).toBe('required');
        await screen.pressByTestIdAsync('bot-template-need-add');
        expect(screen.findByTestId('bot-template-need-catalog-unavailable')).not.toBeNull();
    });

    it('authors MCP declarations with readable names while exporting env and header inputs without source credentials', async () => {
        const buffer = createBotTemplateEditorBuffer({ draft: opening(), revision: { headerVersion: 1, bodyVersion: 1 } });
        const save: BotTemplateSave = async () => ({ ok: true, revision: { headerVersion: 2, bodyVersion: 2 } });
        const screen = await renderScreen(<BotTemplateNeedsSection buffer={buffer} save={save} scope={{ serverId: 'home', accountId: 'author' }} />, { wrapper: page });
        await screen.pressByTestIdAsync('bot-template-need-add');
        await screen.pressByTestIdAsync('bot-template-need-kind:mcpServers');
        await act(async () => {
            screen.changeTextByTestId('bot-template-need-field:new:name', 'Review helpers');
            screen.changeTextByTestId('bot-template-mcp-endpoint', 'review-tool');
            screen.changeTextByTestId('bot-template-mcp-arguments', '--workspace\nexample');
            screen.changeTextByTestId('bot-template-mcp-env', 'API_TOKEN');
        });
        await screen.pressByTestIdAsync('bot-template-need-confirm');
        const portable = projectBotTemplateContentV1(buffer.getSnapshot().draft);
        expect(portable.needs.mcpServers).toHaveLength(1);
        const need = portable.needs.mcpServers[0]!;
        expect(need.name).toBe('Review helpers');
        expect(need.definition).toMatchObject({ transport: 'stdio', stdio: { command: { kind: 'literal', value: 'review-tool' },
            args: [{ kind: 'literal', value: '--workspace' }, { kind: 'literal', value: 'example' }] } });
        expect(need.definition.inputs).toEqual(expect.arrayContaining([expect.objectContaining({ secret: true, required: true })]));
        expect(JSON.stringify(need.definition)).not.toContain('"default"');
        expect(JSON.stringify(need.definition)).not.toContain('"t":"literal"');
    });

    it('generalizes copied command literals in place while retaining recipient inputs and leaving the source definition untouched', async () => {
        const source = McpServerCatalogEntryV1Schema.parse({ id: 'source-private', name: 'review-tools', transport: 'stdio',
            stdio: { command: 'private-command', args: ['--private-team', 'private-team'] },
            env: { API_TOKEN: { t: 'literal', v: 'synthetic-private-token' } }, createdAt: 1, updatedAt: 1 });
        const definition = projectBotTemplateMcpDefinitionV1(source);
        const draft = opening();
        draft.content.needs.mcpServers.push({ key: 'mcp', name: 'Review tools', purpose: 'Review', skipConsequence: 'Manual review',
            requirement: 'optional', definition });
        const buffer = createBotTemplateEditorBuffer({ draft, revision: { headerVersion: 1, bodyVersion: 1 } });
        const save: BotTemplateSave = async () => ({ ok: true, revision: { headerVersion: 2, bodyVersion: 2 } });
        const screen = await renderScreen(<BotTemplateNeedsSection buffer={buffer} save={save} scope={{ serverId: 'home', accountId: 'author' }} />, { wrapper: page });
        await screen.pressByTestIdAsync('bot-template-need:mcpServers:mcp');
        await act(async () => { screen.changeTextByTestId('bot-template-mcp-literal:mcp:command', 'general-command'); });
        await act(async () => { screen.findByTestId('bot-template-mcp-literal:mcp:command')?.props.onBlur(); });
        expect(projectBotTemplateContentV1(buffer.getSnapshot().draft).needs.mcpServers[0]?.definition)
            .toMatchObject({ stdio: { command: { kind: 'literal', value: 'general-command' } }, env: definition.env, inputs: definition.inputs });
        expect(source.stdio?.command).toBe('private-command');
        expect(definition.stdio?.command).toEqual({ kind: 'literal', value: 'private-command' });
        expect(JSON.stringify(buffer.getSnapshot().draft)).not.toContain('synthetic-private-token');
    });
});
