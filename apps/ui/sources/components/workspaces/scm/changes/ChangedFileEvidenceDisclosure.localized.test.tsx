import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
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
    // The real translation owner: this asserts what a person in this locale actually reads, which a
    // key-echo mock cannot show.
    text: async () => vi.importActual('@/text'),
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub, createUseLocalSettingMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({ useLocalSetting: createUseLocalSettingMock() });
});

const boundedEntry: SessionAttributedFile = {
    file: {
        fileName: 'a.ts',
        filePath: 'src/a.ts',
        fullPath: 'src/a.ts',
        status: 'modified',
        isIncluded: false,
        linesAdded: 2,
        linesRemoved: 1,
    },
    turns: ['private-turn'],
    content: { source: 'scm_checkpoint', confidence: 'best_effort' },
    attribution: { confidence: 'session_possible', reason: 'checkpoint_overlap_observed' },
    checkpointOverlap: 'observed',
    evidence: [{
        filePath: 'src/a.ts',
        changeKind: 'modified',
        source: 'scm_checkpoint',
        confidence: 'best_effort',
        provider: 'checkpoint',
        truncated: true,
        stats: { unifiedDiffBytes: 900_000, addedLines: 4_000, removedLines: 3_000 },
    }],
};

const unavailableEntry: SessionAttributedFile = {
    ...boundedEntry,
    attribution: { confidence: 'unknown', reason: 'unavailable' },
    checkpointOverlap: 'unknown',
    evidence: [{
        filePath: 'src/a.ts',
        changeKind: 'unknown',
        source: 'inferred',
        confidence: 'best_effort',
        provider: 'workspace',
    }],
};

async function renderOpenDisclosure(entry: SessionAttributedFile, language: 'de' | 'ja') {
    const { ChangedFileEvidenceDisclosure } = await import('./ChangedFileEvidenceDisclosure');
    const { OverlayPortalProvider, OverlayPortalHost } = await import('@/components/ui/popover/OverlayPortal');
    const i18n = await import('@/text');
    // Finish importing the store-backed presentation graph before choosing the test locale.
    i18n.setPreferredLanguageFromSettings(language);
    const screen = await renderScreen(
        <OverlayPortalProvider>
            <ChangedFileEvidenceDisclosure entry={entry} />
            <OverlayPortalHost />
        </OverlayPortalProvider>,
        {
            createNodeMock: () => ({
                focus: vi.fn(),
                measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) =>
                    callback(10, 10, 250, 48),
            }),
        },
    );
    await screen.pressByTestIdAsync('changed-file-evidence-trigger');
    return screen;
}

describe('ChangedFileEvidenceDisclosure localization', () => {
    afterEach(async () => {
        const i18n = await import('@/text');
        i18n.setPreferredLanguageFromSettings(null);
    });

    it('reads the bounded best-effort evidence in the active locale without falling back to English', async () => {
        const { de } = await import('@/text/translations/de');
        const { en } = await import('@/text/translations/en');

        const screen = await renderOpenDisclosure(boundedEntry, 'de');
        const content = screen.getTextContent();

        expect(content).toContain(de.changedFileEvidence.content.best_effort);
        expect(content).toContain(de.changedFileEvidence.attribution.session_possible);
        expect(content).toContain(de.changedFileEvidence.overlap.observed);
        expect(content).toContain(de.changedFileEvidence.truncated);
        expect(content).toContain(de.changedFileEvidence.sources.scm_checkpoint);
        expect(content).toContain(de.changedFileEvidence.truncatedDiffBytes({ count: 900_000 }));
        // The English sentences are what the locale used to render.
        expect(content).not.toContain(en.changedFileEvidence.content.best_effort);
        expect(content).not.toContain(en.changedFileEvidence.overlap.observed);
        expect(content).not.toContain(en.changedFileEvidence.truncated);

        // Path identity is the only thing that must survive localization verbatim.
        const trigger = screen.findByTestId('changed-file-evidence-trigger');
        expect(trigger?.props.accessibilityLabel)
            .toBe(de.changedFileEvidence.howDeterminedForFile({ path: 'src/a.ts' }));
        expect(String(trigger?.props.accessibilityLabel)).toContain('src/a.ts');
    });

    it('keeps unavailable attribution truthful in the active locale', async () => {
        const { ja } = await import('@/text/translations/ja');
        const { en } = await import('@/text/translations/en');

        const screen = await renderOpenDisclosure(unavailableEntry, 'ja');
        const content = screen.getTextContent();

        expect(content).toContain(ja.changedFileEvidence.attribution.unknown);
        expect(content).toContain(ja.changedFileEvidence.reason.unavailable);
        expect(content).toContain(ja.changedFileEvidence.overlap.unknown);
        expect(content).toContain(ja.changedFileEvidence.sources.inferred);
        expect(content).toContain(ja.changedFileEvidence.kind.unknown);
        expect(content).not.toContain(en.changedFileEvidence.reason.unavailable);
        expect(content).not.toContain(en.changedFileEvidence.overlap.unknown);
        // An unknown attribution must never be dressed up as an exact one.
        expect(content).not.toContain(ja.changedFileEvidence.attribution.session_exact);
    });
});
