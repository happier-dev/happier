import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { MarkdownView } from './MarkdownView';
import { act } from 'react-test-renderer';
import { Pressable } from 'react-native';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { getStorage } from '@/sync/domains/state/storageStore';
import { NativeSessionReferencesProvider } from '@/components/sessions/transcript/references/NativeSessionReferencesProvider';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';

vi.mock('./MermaidRenderer', () => ({ MermaidRenderer: () => null }));

describe('MarkdownView option session links', () => {
    afterEach(standardCleanup);

    it('opens a session link independently while retaining the authored option response', async () => {
        const onLinkPress = vi.fn(() => true);
        const onOptionPress = vi.fn();
        const title = "Include [Release prep](/session/sess_42)'s change";
        const screen = await renderScreen(<MarkdownView
            markdown={`<options>\n<option>${title}</option>\n</options>`}
            onLinkPress={onLinkPress}
            onOptionPress={onOptionPress}
        />);

        const link = screen.findAll((node) => node.props.accessibilityRole === 'link')[0];
        expect(link).toBeTruthy();
        link!.props.onPress();
        expect(onLinkPress).toHaveBeenCalledWith('/session/sess_42');
        expect(onOptionPress).not.toHaveBeenCalled();

        const button = screen.findAllByType(Pressable).find((node) => typeof node.props.onPress === 'function');
        expect(button).toBeTruthy();
        button!.props.onPress();
        expect(onOptionPress).toHaveBeenCalledWith({ title });
        expect(screen.getTextContent()).toContain('Release prep');
        expect(screen.getTextContent()).not.toContain('](/session/');
    });

    it.each([
        { alias: 'happier-6e', providerId: 'claude', inlineCode: false },
        { alias: 'happier-6e', providerId: 'claude', inlineCode: true },
        { alias: 'Turing', providerId: 'codex', inlineCode: true },
    ])('updates an existing $providerId reply and its option (inlineCode=$inlineCode) when verified metadata and current titles arrive', async ({ alias, providerId, inlineCode }) => {
        const store = getStorage();
        const before = store.getState();
        const source = createSessionFixture({ id: 'source' });
        const target = createSessionFixture({ id: 'target', metadata: { path: '/work', host: 'host', machineId: 'machine-1', name: 'First title' } });
        store.setState({ sessions: { source, target }, sessionListRenderables: { target: buildSessionListRenderableFromSession(target) }, deletedSessionIds: {} });
        try {
            const onOptionPress = vi.fn();
            const onLinkPress = vi.fn(() => true);
            const mention = inlineCode ? `\`${alias}\`` : alias;
            const authored = `Include ${mention}'s change`;
            const screen = await renderScreen(<NativeSessionReferencesProvider sessionId="source" text={authored} createdAt={150}>
                <MarkdownView markdown={`Ask ${mention}; happier-eb is unknown.\n\n<options>\n<option>${authored}</option>\n</options>`} onOptionPress={onOptionPress} onLinkPress={onLinkPress} />
            </NativeSessionReferencesProvider>);
            expect(screen.findByType('EnrichedMarkdownText').props.markdown).toContain(`Ask ${mention}`);
            const withEvidence = { ...target, metadataVersion: 2, metadata: { ...target.metadata!, nativeSessionAliasesV1: { v: 1 as const, assignments: [{ providerId, providerSessionId: 'native-target', alias, assignedAt: 100, observedAt: 200 }] } } };
            await act(async () => { store.setState({ sessions: { source, target: withEvidence } }); });
            expect(screen.findByType('EnrichedMarkdownText').props.markdown).toContain('[First title](/session/target)');
            await act(async () => { store.setState({ sessions: { source, target: { ...withEvidence, metadataVersion: 3, metadata: { ...withEvidence.metadata, name: 'Current [title]' } } } }); });
            expect(screen.findByType('EnrichedMarkdownText').props.markdown).toContain('[Current \\[title\\]](/session/target)');
            expect(screen.findByType('EnrichedMarkdownText').props.markdown).toContain('happier-eb is unknown');
            const link = screen.findAll((node) => node.props.accessibilityRole === 'link')[0];
            const stopPropagation = vi.fn();
            link!.props.onPress({ stopPropagation });
            expect(stopPropagation).toHaveBeenCalled();
            expect(onLinkPress).toHaveBeenCalledWith('/session/target');
            expect(onOptionPress).not.toHaveBeenCalled();
            const button = screen.findAllByType(Pressable).find((node) => typeof node.props.onPress === 'function');
            button!.props.onPress();
            expect(onOptionPress).toHaveBeenCalledWith({ title: authored });
            expect(screen.getTextContent()).toContain('Current [title]');
        } finally {
            await act(async () => { store.setState(before, true); });
        }
    });
});
