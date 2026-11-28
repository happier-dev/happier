import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BotTemplateReleaseV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { UserMessageBubble } from '@/components/sessions/transcript/UserMessageBubble';
import { BotTemplateFace } from './BotTemplateFace';
import { BotTemplatePreview } from './BotTemplatePreview';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(standardCleanup);

const release: BotTemplateReleaseV1 = {
    v: 1, version: '1.0.0', releasedAtMs: 1, changelog: 'Initial',
    content: {
        v: 1, identity: { name: 'Example', description: '' }, instructions: { markdown: 'Full instructions\nLast instruction' },
        memoryRules: [{ key: 'memory', text: 'Remember reusable rules', topic: 'Review' }],
        skills: [{ key: 'review', title: 'Review', bundleSchemaId: 'skills.skill_md_v1', entries: [
            { path: 'SKILL.md', contentKind: 'utf8', contentBase64: encodeBase64(new TextEncoder().encode('---\nname: review\ndescription: Review pull requests for risk\n---\nComplete skill instructions')) },
            { path: 'run.sh', contentKind: 'utf8', contentBase64: encodeBase64(new TextEncoder().encode('echo full-script')), unixMode: 0o755 },
            { path: 'reference.bin', contentKind: 'binary', contentBase64: 'AP+A' },
        ] }],
        needs: { software: [], connectedAccounts: [], mcpServers: [{ key: 'mcp', name: 'Review server', requirement: 'optional', purpose: 'Review changes', skipConsequence: 'Remote review unavailable',
            definition: { name: 'Review server', transport: 'stdio', env: { API_TOKEN: { kind: 'input', key: 'token' } },
                stdio: { command: { kind: 'literal', value: '/opt/review' }, args: [{ kind: 'literal', value: '--unsafe-mode=false' }] },
                inputs: [{ key: 'token', label: 'Review API token', purpose: 'Authenticate review service', secret: true, required: true }] } },
            { key: 'remote', name: 'Remote service', requirement: 'required', purpose: 'Read references', skipConsequence: 'Cannot read references',
                definition: { name: 'Remote service', transport: 'http', env: {},
                    remote: { url: { baseUrl: { kind: 'literal', value: 'https://review.example/mcp' }, query: [] }, headers: {} }, inputs: [] } },
        ] },
    },
};

describe('BotTemplatePreview', () => {
    it('opens complete instructions on demand while keeping memory, carried files and MCP literals reviewable before creation (lab R2 / SF1)', async () => {
        const screen = await renderScreen(<BotTemplatePreview content={release.content} />);
        expect(screen.getTextContent()).not.toContain('Last instruction');
        expect(screen.getTextContent()).not.toContain('Complete skill instructions');
        await screen.pressByTestIdAsync('bot-template-instructions-disclosure');
        await screen.pressByTestIdAsync('bot-template-skill:review');
        await screen.pressByTestIdAsync('bot-template:file:review:run.sh');
        const text = screen.getTextContent();
        for (const value of ['Last instruction', 'Remember reusable rules', 'Complete skill instructions', 'echo full-script', '755', '/opt/review', '--unsafe-mode=false', 'Review API token', 'Remote review unavailable', 'https://review.example/mcp']) {
            expect(text).toContain(value);
        }
        await screen.pressByTestIdAsync('bot-template-instructions-disclosure');
        expect(screen.getTextContent()).not.toContain('Last instruction');
    });

    it('leaves needs to the setup controls while keeping carried content openable', async () => {
        const screen = await renderScreen(<BotTemplatePreview content={release.content} showNeeds={false} />);
        expect(screen.findByTestId('bot-template-need:mcpServers:mcp')).toBeNull();
        expect(screen.getTextContent()).not.toContain('Complete skill instructions');
        await screen.pressByTestIdAsync('bot-template-skill:review');
        expect(screen.getTextContent()).toContain('Complete skill instructions');
    });

    it('reads instructions and skills as documents, never as raw Markdown or front matter (F4)', async () => {
        const content = { ...release.content, instructions: { markdown: '# Coffee Companion\n\nBe **curious**.' } };
        const screen = await renderScreen(<BotTemplatePreview content={content} />);
        // A skill is one readable row: its title and what it is for, from its own front matter.
        expect(screen.getTextContent()).toContain('Review pull requests for risk');
        await screen.pressByTestIdAsync('bot-template-instructions-disclosure');
        await screen.pressByTestIdAsync('bot-template-skill:review');
        const text = screen.getTextContent();
        // Instructions render through the shared Markdown renderer rather than as plain text.
        expect(screen.findByTestId('bot-template-instructions-document')).not.toBeNull();
        expect(text).toContain('Coffee Companion');
        expect(text).toContain('Complete skill instructions');
        expect(text).not.toContain('name: review');
        // SKILL.md is the skill itself, not a carried file box beside it.
        expect(screen.findByTestId('bot-template:file:review:SKILL.md')).toBeNull();
    });

    it('keeps "Try it with" and "What it needs" in place when the template has neither (F4)', async () => {
        const empty = { ...release.content, firstTask: undefined, needs: { software: [], connectedAccounts: [], mcpServers: [] } };
        const screen = await renderScreen(<BotTemplatePreview content={empty} />);
        expect(screen.findByTestId('bot-template-first-task-empty')).not.toBeNull();
        expect(screen.findByTestId('bot-template-needs-empty')).not.toBeNull();
    });

    it('opens a carried binary companion and offers download before creating a saved skill', async () => {
        const download = vi.fn();
        const screen = await renderScreen(<BotTemplatePreview content={release.content} onDownloadFile={download} />);
        await screen.pressByTestIdAsync('bot-template-skill:review');
        expect(screen.getTextContent()).toContain('reference.bin');
        await screen.pressByTestIdAsync('bot-template:file:review:reference.bin');
        await screen.pressByTestIdAsync('bot-template:file:review:reference.bin:download');
        expect(download).toHaveBeenCalledWith('review', 'reference.bin');
    });

    it('shows the worked example as the conversation it stands for: the request in a prompt bubble, the reply beside the Bot\'s face (lab G2)', async () => {
        const content = { ...release.content, workedExample: { request: 'Review #2481 Retry reconnect with backoff', reply: '#2481 is close. I drafted the comment.' } };
        const screen = await renderScreen(<BotTemplatePreview content={content} />);
        const bubble = screen.findAll((node) => node.type === UserMessageBubble);
        expect(bubble.map((node) => node.props.testID)).toEqual(['bot-template-example-request']);
        expect(bubble[0]!.findAll((node) => node.props.children === content.workedExample.request)).not.toHaveLength(0);
        const reply = screen.findByTestId('bot-template-example-reply');
        expect(reply).not.toBeNull();
        expect(reply!.findAll((node) => node.type === BotTemplateFace)).toHaveLength(1);
        expect(reply!.findAll((node) => node.props.children === content.workedExample.reply)).not.toHaveLength(0);
    });
});
