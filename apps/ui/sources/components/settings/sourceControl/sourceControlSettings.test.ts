import { describe, expect, it } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { readBuiltInSettingDeclarationV1, readBuiltInAccountSettingValueV1 } from '@happier-dev/protocol/actions/settings/settingsDeclarations';
import { SOURCE_CONTROL_SETTINGS } from './sourceControlSettings';
import { fileEditingTranslations } from '@/text/translations/fileEditingTranslations.shared';

describe('AI suggestion Settings declaration composition', () => {
    it('projects all ten rendered rows from portable metadata with labels and Account readers', () => {
        const expected = [
            ['aiSuggestionsEnabled', 'enabled'], ['aiSuggestionsProvider', 'provider'], ['aiSuggestionsModel', 'model'], ['aiSuggestionsNextEdit', 'nextEdit'], ['aiSuggestionsNextEditModel', 'nextEditModel'],
            ['aiSuggestionsMode', 'mode'], ['aiSuggestionsDelay', 'delay'], ['aiSuggestionsExcluded', 'excluded'],
            ['aiSuggestionsDisabledLanguages', 'disabledLanguages'], ['aiSuggestionsUsage', 'usage'],
        ] as const;
        const settings = accountSettingsParse({});
        expect(SOURCE_CONTROL_SETTINGS.sectionRefs.aiSuggestions.settingAnchors).toHaveLength(expected.length);
        for (const [key, label] of expected) {
            const ref = SOURCE_CONTROL_SETTINGS.settings[key];
            const portable = readBuiltInSettingDeclarationV1(ref.anchor);
            expect(portable, ref.anchor).not.toBeNull();
            expect(ref.sectionId).toBe('sourceControl.aiSuggestions');
            expect(ref.titleKey).toBe(`files.editing.aiSuggestions.${label}`);
            for (const locale of Object.values(fileEditingTranslations)) expect(locale.aiSuggestions[label].length).toBeGreaterThan(0);
            if (key !== 'aiSuggestionsUsage') {
                expect(portable?.storage?.key).toBe('filesEditorAiSuggestionsV1');
                expect(readBuiltInAccountSettingValueV1(portable!, settings)).not.toBeUndefined();
            }
        }
    });
});
