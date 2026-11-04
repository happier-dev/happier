import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { BotTemplateHeader } from './BotTemplateHeader';

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
// Exercise the web paint adapter at the platform boundary.
vi.mock('@/components/sessions/bots/face/BotFaceRasterView', async () => import('@/components/sessions/bots/face/BotFaceRasterView.web'));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

describe('shared template identity', () => {
    it('shows the known version without inventing author or sharing facts', async () => {
        const screen = await renderScreen(<BotTemplateHeader identity={{ name: 'Garden', description: 'Garden advice', madeFromName: 'Source garden' }}
            version="1.2.0" presentation={{ ownerDisplayName: null }} />);
        const content = screen.getTextContent();
        expect(content).toContain('Garden');
        expect(content).toContain('1.2.0');
        expect(content).not.toContain('botTemplates.byline');
        expect(content).not.toContain('botTemplates.private');
        expect(content).not.toContain('botTemplates.shared');
        await screen.unmount();
    });

    it('labels an admitted private release while keeping an unavailable owner name unknown', async () => {
        const screen = await renderScreen(<BotTemplateHeader identity={{ name: 'Garden', description: 'Garden advice' }}
            version="1.2.0" presentation={{ ownerDisplayName: null, shared: false }} />);
        const content = screen.getTextContent();
        expect(content).toContain('1.2.0');
        expect(content).toContain('botTemplates.private');
        expect(content).not.toContain('botTemplates.byline');
        await screen.unmount();
    });
});
