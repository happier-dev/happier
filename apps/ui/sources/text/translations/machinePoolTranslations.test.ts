import { describe, expect, it } from 'vitest';

import { auditTranslations, flattenTranslationLeaves } from '../../../tools/i18n/translationAudit';

import { machinePoolTranslations } from './machinePoolTranslations';

describe('machinePoolTranslations', () => {
    it('keeps every Machine Pool surface complete in every supported locale', () => {
        const { en, ...localesByCode } = machinePoolTranslations;
        const locales = Object.entries(localesByCode).map(([code, root]) => ({ code, root }));
        const expectedLeaves = flattenTranslationLeaves(en)
            .map((leaf) => `${leaf.key}:${leaf.kind}`)
            .sort();

        const shapeMismatches = locales.flatMap(({ code, root }) => {
            const actualLeaves = flattenTranslationLeaves(root)
                .map((leaf) => `${leaf.key}:${leaf.kind}`)
                .sort();
            return JSON.stringify(actualLeaves) === JSON.stringify(expectedLeaves)
                ? []
                : [`${code}: Machine Pool translation shape differs from English`];
        });
        // Audit at the mounted path (`machinePools.*`) so the shared cognate allowlist keys apply.
        const untranslated = Object.values(auditTranslations({
            en: { machinePools: en },
            locales: locales.map(({ code, root }) => ({ code, root: { machinePools: root } })),
        }))
            .flatMap((report) => report.untranslatedStrings)
            .map((entry) => `${entry.locale}: ${entry.key} = ${JSON.stringify(entry.value)}`);

        expect(shapeMismatches).toEqual([]);
        expect(untranslated).toEqual([]);
    });

    it('localizes the interpolated Machine Pool copy instead of falling back to English', () => {
        const { en, ...localesByCode } = machinePoolTranslations;
        const availabilitySample: Parameters<typeof en.availabilityKnown>[0] = { connected: 2, enabled: 3 };
        const fallbackSample: Parameters<typeof en.fallback>[0] = { number: 1 };

        const inherited = Object.entries(localesByCode).flatMap(([code, root]) => [
            root.availabilityKnown(availabilitySample) === en.availabilityKnown(availabilitySample)
                ? `${code}: machinePools.availabilityKnown falls back to English`
                : null,
            root.fallback(fallbackSample) === en.fallback(fallbackSample)
                ? `${code}: machinePools.fallback falls back to English`
                : null,
        ].filter((failure): failure is string => failure !== null));

        expect(inherited).toEqual([]);
    });

    it('says a Pool’s connection state as an outcome, not a count of enabled members', () => {
        expect(machinePoolTranslations.en.availabilityKnown({ connected: 0, enabled: 1 })).toBe('No machine online');
        expect(machinePoolTranslations.en.availabilityKnown({ connected: 2, enabled: 3 })).toBe('2 of 3 online');
    });

    it('labels the concept “machine pool” wherever a Connected Service Pool could be confused with it', () => {
        // Settings, the New Session picker and the delete confirmation all sit within reach of the
        // Connected Service Pools surface, so the Machine Pool entry points name the exact concept
        // (Lane 11 umbrella, revision 7 disambiguation delta).
        expect(machinePoolTranslations.en.title).toMatch(/machine pool/i);
        expect(machinePoolTranslations.en.add).toMatch(/machine pool/i);
        expect(machinePoolTranslations.en.delete).toMatch(/machine pool/i);
        expect(machinePoolTranslations.en.openSettings).toMatch(/machine pool/i);
    });

    it('warns that deleting a machine pool clears credential broker placement without affecting machines or running sessions', () => {
        expect(machinePoolTranslations.en.deleteBody).toMatch(/credential resource/i);
        expect(machinePoolTranslations.en.deleteBody).toMatch(/broker location/i);
        expect(machinePoolTranslations.en.deleteBody).toMatch(/repair/i);
        expect(machinePoolTranslations.en.deleteBody).toMatch(/does not delete machines/i);
        expect(machinePoolTranslations.en.deleteBody).toMatch(/running sessions/i);
    });

    it('explains the future-only effect of member and tier edits beside those controls', () => {
        // Edits affect only what starts after saving; what is already open keeps its machine. The broker
        // detail (a connection stays on the machine chosen when it opened) is `connectionSemantics`'.
        expect(machinePoolTranslations.en.placementChangeNotice).toMatch(/after you save/i);
        expect(machinePoolTranslations.en.placementChangeNotice).toMatch(/open sessions stay/i);
    });

    it('explains Pool broker selection at connection time', () => {
        expect(machinePoolTranslations.en.connectionSemantics).toMatch(/when a connection opens/i);
        expect(machinePoolTranslations.en.connectionSemantics).toMatch(/stays selected/i);
        expect(machinePoolTranslations.en.connectionSemantics).toMatch(/later connection/i);
        expect(machinePoolTranslations.en.connectionSemantics).toMatch(/another machine/i);
    });
});
