import { describe, expect, it } from 'vitest';

import {
    ACCOUNT_SESSION_CREATION_SETTING_DEFINITIONS,
    resolveNewSessionWizardSectionPresentation,
} from '@/sync/domains/settings/registry/account/accountSessionCreationSettingDefinitions';

describe('account session creation setting definitions', () => {
    it('defaults new-session wizard section presentation overrides to auto', () => {
        expect(ACCOUNT_SESSION_CREATION_SETTING_DEFINITIONS.newSessionWizardSectionPresentationV1.default).toEqual({});
        expect(resolveNewSessionWizardSectionPresentation({}, 'models')).toBe('auto');
    });

    it('defaults the new-session wizard column layout preference to disabled', () => {
        expect(ACCOUNT_SESSION_CREATION_SETTING_DEFINITIONS.newSessionWizardColumnsEnabled.default).toBe(false);
    });

    it('keeps valid wizard presentation overrides and drops unknown section or presentation values', () => {
        const schema = ACCOUNT_SESSION_CREATION_SETTING_DEFINITIONS.newSessionWizardSectionPresentationV1.schema;
        const parsed = schema.parse({
            models: 'dropdown',
            machines: 'list',
            unknown: 'dropdown',
            paths: 'grid',
        });

        expect(parsed).toEqual({
            models: 'dropdown',
            machines: 'list',
        });
    });
});
