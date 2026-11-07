import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

import { CapabilityListingSections } from './CapabilityListingSections';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
afterEach(async () => { await standardCleanup(); });

describe('CapabilityListingSections', () => {
    it.each([undefined, null, '', '0.0.0'])('omits unknown version facts (%s) while retaining provenance', async version => {
        const screen = await renderScreen(<CapabilityListingSections testID="l" facts={{
            version, versionNote: 'Plugin version', sourceTitle: 'Included with Happier',
        }} />);
        expect(screen.findHostByTestId('l.versions')).toBeFalsy();
        expect(screen.findHostByTestId('l.source')).toBeTruthy();
    });
    it('closes a listing with its version and where it comes from, linking the repository with its licence', async () => {
        const screen = await renderScreen(<CapabilityListingSections testID="l" facts={{
            version: '1.4.0', sourceTitle: 'MCP Registry', license: 'MIT',
            links: { repository: 'https://github.com/makenotion/notion-mcp-server.git' },
        }} />);
        expect(screen.findHostByTestId('l.versions')).toBeTruthy();
        const text = screen.getTextContent();
        expect(text).toContain('1.4.0');
        expect(text).toContain('MCP Registry');
        expect(text).toContain('github.com/makenotion/notion-mcp-server');
        expect(text).toContain('MIT');
        expect(screen.findHostByTestId('l.source.link')).toBeTruthy();
    });

    it('says what a version belongs to instead of calling it current in the source', async () => {
        const screen = await renderScreen(<CapabilityListingSections testID="l" facts={{
            version: '0.4.2', versionNote: 'Version of the plugin that offers this', sourceTitle: 'Included with Happier',
        }} />);
        const text = screen.getTextContent();
        expect(text).toContain('0.4.2');
        expect(text).toContain('Version of the plugin that offers this');
        expect(text).not.toContain('currentIn');
        expect(text).toContain('Included with Happier');
    });

    it('draws no section for facts the listing does not hold', async () => {
        const screen = await renderScreen(<CapabilityListingSections testID="l" facts={{ links: { repository: 'javascript:alert(1)' } }} />);
        expect(screen.findHostByTestId('l.versions')).toBeFalsy();
        expect(screen.findHostByTestId('l.source')).toBeFalsy();
    });
});
