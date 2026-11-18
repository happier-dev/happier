import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ComposerAttachmentViewV1 } from '@happier-dev/protocol/runtime/input/composerAttachmentV1';

import { renderScreen } from '@/dev/testkit';
import { buildComposerSnapshotStructuredInputMetaOverrides } from '../../composer/composerScopeAdapters';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

const { ComposerAttachmentFallbackRow } = await import('./ComposerAttachmentFallbackRow');
const { resolveMessageComposerAttachments } = await import('./messageComposerAttachments');

describe('persisted composer attachment replay', () => {
    it('replays submitted Triage presentation after a JSON reload and remount without live plugin services', async () => {
        const attachment: ComposerAttachmentViewV1 = {
            v: 1,
            instanceId: 'triage-entry-42',
            attachment: { pluginId: 'happier.triage', localId: 'entry' },
            key: 'issue-42',
            value: {
                v: 1,
                entryRef: {
                    source: { pluginId: 'happier.forge', localId: 'items' },
                    kindId: 'issue',
                    collisionScope: 'private-repository-scope',
                    entryId: '42',
                },
                sourceInstance: {
                    source: { pluginId: 'happier.forge', localId: 'items' },
                    sourceInstanceId: '2f1c9b4e-7a55-4a8c-9d2e-0b6f4c3a1d78',
                },
            },
            presentation: {
                typeLabel: 'Issue',
                label: 'Issue #42',
                description: 'Presentation captured at Send',
                icon: 'info',
                tone: 'warning',
            },
            availability: { status: 'ready' },
        };
        const metadata = buildComposerSnapshotStructuredInputMetaOverrides({
            text: 'Investigate this issue.',
            references: [],
            attachments: [attachment],
        });
        // The persistence boundary retains bytes, not the live draft or plugin.
        const persistedBytes = JSON.stringify(metadata);
        const mounted = await renderScreen(<ComposerAttachmentFallbackRow
            messageId="sent-message"
            attachments={resolveMessageComposerAttachments(JSON.parse(persistedBytes))}
        />);
        expect(mounted.getTextContent()).toContain('Issue: Issue #42');
        expect(mounted.getTextContent()).toContain('Presentation captured at Send');
        await mounted.unmount();

        attachment.presentation.label = 'Changed current draft';
        attachment.presentation.description = 'Changed after admission';
        const reloaded = resolveMessageComposerAttachments(JSON.parse(persistedBytes));
        const replay = await renderScreen(<ComposerAttachmentFallbackRow
            messageId="sent-message"
            attachments={reloaded}
        />);
        expect(replay.findByTestId('transcript-composer-attachment:sent-message:triage-entry-42')).not.toBeNull();
        expect(replay.getTextContent()).toContain('Issue: Issue #42');
        expect(replay.getTextContent()).toContain('Presentation captured at Send');
        expect(replay.getTextContent()).not.toContain('Changed current draft');
        expect(JSON.stringify(reloaded)).not.toContain('private-repository-scope');
        expect(JSON.stringify(reloaded)).not.toContain('happier.triage');
        await replay.unmount();
    });
});
