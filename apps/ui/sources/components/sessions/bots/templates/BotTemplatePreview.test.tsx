import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BotTemplateReleaseV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
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
            { path: 'SKILL.md', contentKind: 'utf8', contentBase64: encodeBase64(new TextEncoder().encode('---\nname: review\ndescription: Review\n---\nComplete skill instructions')) },
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
    it('discloses complete instructions, memory, carried text, executable mode and MCP literals before creation', async () => {
        const screen = await renderScreen(<BotTemplatePreview content={release.content} />);
        await screen.pressByTestIdAsync('bot-template:file:review:run.sh');
        const text = screen.getTextContent();
        for (const value of ['Last instruction', 'Remember reusable rules', 'Complete skill instructions', 'echo full-script', '755', '/opt/review', '--unsafe-mode=false', 'Review API token', 'Remote review unavailable', 'https://review.example/mcp']) {
            expect(text).toContain(value);
        }
    });

    it('opens a carried binary companion and offers download before creating a saved skill', async () => {
        const download = vi.fn();
        const screen = await renderScreen(<BotTemplatePreview content={release.content} onDownloadFile={download} />);
        expect(screen.getTextContent()).toContain('reference.bin');
        await screen.pressByTestIdAsync('bot-template:file:review:reference.bin');
        await screen.pressByTestIdAsync('bot-template:file:review:reference.bin:download');
        expect(download).toHaveBeenCalledWith('review', 'reference.bin');
    });
});
