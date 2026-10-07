import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import type { RepositoryCheckpointTurnMetadata } from '@happier-dev/protocol';
import type { SessionAttributedFile } from '@/scm/scmAttribution';
import { installSourceControlChangesCommonModuleMocks } from './sourceControlChangesTestHelpers';

installSourceControlChangesCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'ios', select: (value: Record<string, unknown>) => value.ios ?? value.native ?? value.default },
            useWindowDimensions: () => ({ width: 800, height: 600 }),
            Pressable: 'Pressable',
            View: 'View',
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string, params?: { path?: string }) => params?.path ? `${key}:${params.path}` : key });
    },
});
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub, createUseLocalSettingMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({ useLocalSetting: createUseLocalSettingMock() });
});

const entry: SessionAttributedFile = {
    file: { fileName: 'a.ts', filePath: '', fullPath: 'a.ts', status: 'modified', isIncluded: false, linesAdded: 2, linesRemoved: 1 },
    turns: ['private-turn'],
    content: { source: 'scm_checkpoint', confidence: 'exact' },
    attribution: { confidence: 'session_possible', reason: 'checkpoint_overlap_observed' },
    checkpointOverlap: 'observed',
    evidence: [
        { filePath: 'a.ts', changeKind: 'modified', source: 'scm_checkpoint', confidence: 'exact', provider: 'checkpoint' },
        { filePath: 'a.ts', changeKind: 'modified', source: 'provider_tool', confidence: 'strong', provider: 'agent', unifiedDiff: '@@ -1 +1 @@\n-old\n+new', agentTurnId: 'private-turn' },
    ],
};

describe('ChangedFileEvidenceDisclosure', () => {
    it('names repeated disclosure buttons with their file paths', async () => {
        const { ChangedFileEvidenceDisclosure } = await import('./ChangedFileEvidenceDisclosure');
        const secondEntry: SessionAttributedFile = {
            ...entry,
            file: { ...entry.file, fileName: 'b.ts', filePath: 'src/b.ts', fullPath: 'src/b.ts' },
        };
        const firstEntry: SessionAttributedFile = {
            ...entry,
            file: { ...entry.file, filePath: 'src/a.ts', fullPath: 'src/a.ts' },
        };
        const screen = await renderScreen(<><ChangedFileEvidenceDisclosure entry={firstEntry} /><ChangedFileEvidenceDisclosure entry={secondEntry} /></>);
        const labels = screen.tree.root
            .findAllByProps({ testID: 'changed-file-evidence-trigger' })
            .map((trigger) => trigger.props.accessibilityLabel);
        expect(labels).toEqual([
            'changedFileEvidence.howDeterminedForFile:src/a.ts',
            'changedFileEvidence.howDeterminedForFile:src/b.ts',
        ]);
        expect(new Set(labels).size).toBe(2);
    });
    it('qualifies process-local negative observations without claiming exclusivity', async () => {
        const { checkpointAttributionDescription } = await import('./ChangedFileEvidenceDisclosure');
        const metadata: RepositoryCheckpointTurnMetadata = { version: 1, scopeId: 'private-scope', baseRefSource: 'turn_start', contentConfidence: 'exact', attributionScope: 'unknown', receipts: [] };
        expect(checkpointAttributionDescription(metadata)).toBe('changedFileEvidence.overlap.unknown');
        expect(checkpointAttributionDescription({ ...metadata, attributionScope: 'no_happier_checkpoint_overlap_observed' })).toBe('changedFileEvidence.overlap.not_observed');
        expect(checkpointAttributionDescription({ ...metadata, contentConfidence: 'unavailable' })).toBe('files.checkpointUnavailable');
        expect(checkpointAttributionDescription(null)).toBeNull();
    });
    it('qualifies a Session scope without claiming exclusivity and adds overlap only when it was observed', async () => {
        const { sessionAttributionDescriptions } = await import('./ChangedFileEvidenceDisclosure');
        expect(sessionAttributionDescriptions({
            attribution: { confidence: 'session_likely', reason: 'checkpoint_no_happier_overlap_observed' },
            checkpointOverlap: 'not_observed',
        })).toEqual(['changedFileEvidence.attribution.session_likely']);
        expect(sessionAttributionDescriptions({
            attribution: { confidence: 'session_possible', reason: 'checkpoint_overlap_observed' },
            checkpointOverlap: 'observed',
        })).toEqual([
            'changedFileEvidence.attribution.session_possible',
            'changedFileEvidence.overlap.observed',
        ]);
        expect(sessionAttributionDescriptions({
            attribution: { confidence: 'unknown', reason: 'unavailable' },
            checkpointOverlap: 'unknown',
        })).toEqual(['changedFileEvidence.attribution.unknown']);
    });

    it('keeps exact content independent of uncertain attribution and progressively reveals retained sources', async () => {
        const { ChangedFileEvidenceDisclosure } = await import('./ChangedFileEvidenceDisclosure');
        const { OverlayPortalProvider, OverlayPortalHost } = await import('@/components/ui/popover/OverlayPortal');
        const focus = vi.fn();
        const screen = await renderScreen(<OverlayPortalProvider><ChangedFileEvidenceDisclosure entry={entry} /><OverlayPortalHost /></OverlayPortalProvider>, {
            createNodeMock: () => ({
                focus,
                measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(10, 10, 250, 48),
            }),
        });
        expect(screen.getTextContent()).toContain('changedFileEvidence.content.exact');
        expect(screen.getTextContent()).toContain('changedFileEvidence.attribution.session_possible');
        expect(screen.findByTestId('changed-file-evidence-details')).toBeNull();
        await screen.pressByTestIdAsync('changed-file-evidence-trigger');
        expect(screen.getTextContent()).toContain('changedFileEvidence.sources.scm_checkpoint');
        expect(screen.getTextContent()).toContain('changedFileEvidence.sources.provider_tool');
        expect(screen.getTextContent()).toContain('changedFileEvidence.overlap.observed');
        expect(screen.getTextContent()).not.toContain('private-turn');
        expect(screen.getTextContent()).toContain('@@ -1 +1 @@\n-old\n+new');
        await screen.pressByTestIdAsync('changed-file-evidence-close');
        expect(screen.findByTestId('changed-file-evidence-details')).toBeNull();
        expect(focus).toHaveBeenCalled();
    });

    it('discloses when retained evidence was bounded', async () => {
        const { ChangedFileEvidenceDisclosure } = await import('./ChangedFileEvidenceDisclosure');
        const { OverlayPortalProvider, OverlayPortalHost } = await import('@/components/ui/popover/OverlayPortal');
        const truncatedEntry: SessionAttributedFile = {
            ...entry,
            content: { source: 'scm_checkpoint', confidence: 'best_effort' },
            evidence: [{
                filePath: 'a.ts',
                changeKind: 'modified',
                source: 'scm_checkpoint',
                confidence: 'best_effort',
                provider: 'checkpoint',
                truncated: true,
                stats: { unifiedDiffBytes: 900_000, addedLines: 4000, removedLines: 3000 },
            }],
        };
        const screen = await renderScreen(<OverlayPortalProvider><ChangedFileEvidenceDisclosure entry={truncatedEntry} /><OverlayPortalHost /></OverlayPortalProvider>, {
            createNodeMock: () => ({
                focus: vi.fn(),
                measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(10, 10, 250, 48),
            }),
        });

        await screen.pressByTestIdAsync('changed-file-evidence-trigger');
        expect(screen.findByTestId('changed-file-evidence-truncated-notice')).not.toBeNull();
        expect(screen.getTextContent()).toContain('changedFileEvidence.truncated');
        expect(screen.getTextContent()).toContain('changedFileEvidence.truncatedDiffBytes');
        expect(screen.getTextContent()).toContain('changedFileEvidence.truncatedAddedLines');
        expect(screen.getTextContent()).toContain('changedFileEvidence.truncatedRemovedLines');
    });
});
