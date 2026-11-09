import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createTestSessionTranscriptSource, renderWithSessionTranscriptSource } from '@/dev/testkit';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

const { ComposerAttachmentFallbackRow } = await import('./ComposerAttachmentFallbackRow');
const { resolveMessageComposerAttachments } = await import('./messageComposerAttachments');

describe('composer attachment source navigation', () => {
    it('opens the committed source through transcript navigation using only admitted presentation facts', async () => {
        const navigate = vi.fn();
        const source = { kind: 'session', session: { serverId: 'home-a', sessionId: 'session-a' }, messageId: 'committed-a' };
        const attachments = resolveMessageComposerAttachments({ happierStructuredInputV1: { v: 1, composerAttachments: [{
            v: 1, instanceId: 'annotation-1', key: 'annotation-1', attachment: { pluginId: 'happier.app-context', localId: 'transcript-annotation' },
            value: { secret: 'never resolve at render' },
            presentation: { label: 'Selected passage', typeLabel: 'Annotation', description: 'Explain this', source },
        }] } });
        const screen = await renderWithSessionTranscriptSource(
            <ComposerAttachmentFallbackRow messageId="sent-message" attachments={attachments} />,
            createTestSessionTranscriptSource({ navigate }),
        );
        const link = screen.findByTestId('transcript-composer-attachment-source:sent-message:annotation-1');
        expect(link).not.toBeNull();
        await screen.pressByTestId('transcript-composer-attachment-source:sent-message:annotation-1');
        expect(navigate).toHaveBeenCalledWith(buildScopedSessionRouteHref({
            sessionId: 'session-a', serverId: 'home-a', messageId: 'committed-a',
        }));
        await screen.unmount();
    });
});
