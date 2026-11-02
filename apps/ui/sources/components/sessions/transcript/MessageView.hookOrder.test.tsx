import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { AgentTextMessage } from '@/sync/domains/messages/messageTypes';

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});

it('keeps empty voice turns hidden when the same message gains and loses visible text', async () => {
    const { MessageView } = await import('./MessageView');
    const message: AgentTextMessage = {
        kind: 'agent-text', id: 'voice-hook-order', localId: null, createdAt: 1, text: '   ',
        meta: { happier: {
            kind: 'voice_agent_turn.v1',
            payload: { v: 1, epoch: 4, role: 'assistant', voiceAgentId: 'mid', ts: 101 },
        } },
    };
    const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" historical />);
    expect(screen.tree.toJSON()).toBeNull();

    await screen.update(<MessageView message={{ ...message, text: 'Here is the next step.' }} metadata={null} sessionId="s1" historical />);
    expect(screen.tree.toJSON()).not.toBeNull();

    await screen.update(<MessageView message={message} metadata={null} sessionId="s1" historical />);
    expect(screen.tree.toJSON()).toBeNull();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

afterEach(() => {
    standardCleanup();
});

it('keeps a growing thinking message safe when its display setting changes from hidden to inline and back', async () => {
    const { storage } = await import('@/sync/domains/state/storage');
    const { MessageView } = await import('./MessageView');
    const previousSettings = storage.getState().settings;
    storage.setState({ settings: {
        ...previousSettings,
        sessionThinkingDisplayMode: 'hidden',
        sessionThinkingInlinePresentation: 'full',
        sessionThinkingInlineChrome: 'plain',
        transcriptStreamingSmoothingEnabled: false,
    } });
    const message: AgentTextMessage = {
        kind: 'agent-text', id: 'thinking-hook-order', localId: null, createdAt: 1,
        text: 'Thinking through the next step', isThinking: true,
        transcriptObservationProvenance: { kind: 'non_dependent', source: 'history' },
    };

    try {
        const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);
        expect(screen.findByTestId('transcript-thinking-body-markdown')).toBeNull();
        expect(screen.findByTestId('transcript-recovered-history:thinking-hook-order')).not.toBeNull();

        const hiddenUpdate = { ...message, text: 'Thinking through the next step while more text arrives' };
        await screen.update(<MessageView message={hiddenUpdate} metadata={null} sessionId="s1" />);
        expect(screen.findByTestId('transcript-thinking-body-markdown')).toBeNull();

        await act(async () => {
            storage.setState((state) => ({ settings: { ...state.settings, sessionThinkingDisplayMode: 'inline' } }));
        });
        expect(screen.findByTestId('transcript-thinking-body-markdown')).not.toBeNull();
        expect(JSON.stringify(screen.tree.toJSON())).toContain(hiddenUpdate.text);

        const visibleUpdate = { ...message, text: 'Thinking through the next step while more text arrives, then choosing an action' };
        await screen.update(<MessageView message={visibleUpdate} metadata={null} sessionId="s1" />);
        expect(JSON.stringify(screen.tree.toJSON())).toContain(visibleUpdate.text);

        await act(async () => {
            storage.setState((state) => ({ settings: { ...state.settings, sessionThinkingDisplayMode: 'hidden' } }));
        });
        await screen.update(<MessageView message={{ ...message, text: `${visibleUpdate.text}, with another update` }} metadata={null} sessionId="s1" />);
        expect(screen.findByTestId('transcript-thinking-body-markdown')).toBeNull();
        expect(screen.findByTestId('transcript-recovered-history:thinking-hook-order')).not.toBeNull();
    } finally {
        standardCleanup();
        storage.setState({ settings: previousSettings });
    }
});
