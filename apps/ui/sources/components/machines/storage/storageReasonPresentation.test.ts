import { afterEach, describe, expect, it } from 'vitest';
import { StorageEvidenceCodeV1Schema } from '@happier-dev/protocol/storage/storageV1';

import { preloadTranslationsForSettings, setPreferredLanguageFromSettings, t } from '@/text';
import { machineDetailPageTranslations } from '@/text/translations/machineDetailPageTranslations';

import { describeStorageLosses, storageEvidenceLabel } from './storageReasonPresentation';

afterEach(() => setPreferredLanguageFromSettings('en'));

describe('storage evidence presentation', () => {
    it('keeps unfamiliar evidence neutral and conceals native recognizer and manifest identifiers', () => {
        expect(storageEvidenceLabel('future_private_evidence')).toBe(t('machineStorage.evidence.unknown'));
        expect(storageEvidenceLabel('')).toBe(t('machineStorage.evidence.unknown'));
        expect(storageEvidenceLabel('recognizer:')).toBe(t('machineStorage.evidence.unknown'));
        expect(storageEvidenceLabel('manifest:')).toBe(t('machineStorage.evidence.unknown'));
        expect(storageEvidenceLabel('recognizer:private-detector')).toBe(t('machineStorage.evidence.recognizer'));
        expect(storageEvidenceLabel('manifest:private-project.json')).toBe(t('machineStorage.evidence.manifest'));
        expect(storageEvidenceLabel('managed_cache_root')).not.toBe(storageEvidenceLabel('unknown'));
    });

    it.each(['en', 'ca', 'de', 'es', 'fr', 'it', 'ja', 'pl', 'pt', 'ru', 'zh-Hans', 'zh-Hant'] as const)('uses canonical evidence copy in %s', async language => {
        const evidence = [...StorageEvidenceCodeV1Schema.options, 'recognizer:private-detector', 'manifest:private-project.json'];
        await preloadTranslationsForSettings(language);
        setPreferredLanguageFromSettings(language);
        for (const code of evidence) {
            const label = storageEvidenceLabel(code);
            const key = code.startsWith('recognizer:') ? 'recognizer'
                : code.startsWith('manifest:') ? 'manifest'
                : StorageEvidenceCodeV1Schema.parse(code);
            expect(label).toBe(machineDetailPageTranslations[language].machineStorage.evidence[key]);
            expect(label.length).toBeGreaterThan(0);
            expect(label).not.toMatch(/machineStorage\.|private-detector|private-project\.json/u);
            expect(label).not.toBe(code);
        }
    });
});

describe('storage losses', () => {
    it('names the file, not a folder, when the item in use is one file', () => {
        expect(describeStorageLosses([{ code: 'in_use' }])).toContain('folder');
        const file = describeStorageLosses([{ code: 'in_use' }], { file: true });
        expect(file).not.toContain('folder');
        expect(file).toContain('file');
    });
});
