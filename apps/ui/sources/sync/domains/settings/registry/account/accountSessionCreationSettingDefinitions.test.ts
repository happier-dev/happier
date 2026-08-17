import { describe, expect, it } from 'vitest';
import { ACCOUNT_SETTING_DEFINITIONS } from '@happier-dev/protocol';

import {
    NEW_SESSION_PRESENTATION_MODES,
    resolveNewSessionWizardSectionPresentation,
} from '@/sync/domains/settings/registry/account/accountSessionCreationSettingDefinitions';
import { LOCAL_ACCOUNT_SETTING_DEFINITIONS } from '@/sync/domains/settings/registry/local/localAccountSettingDefinitions';

describe('account session creation setting definitions', () => {
    it('defaults new-session wizard section presentation overrides to auto', () => {
        expect(ACCOUNT_SETTING_DEFINITIONS.newSessionWizardSectionPresentationV1.default).toEqual({});
        expect(resolveNewSessionWizardSectionPresentation({}, 'models')).toBe('auto');
    });

    it('defaults the new-session wizard column layout preference to disabled', () => {
        expect(ACCOUNT_SETTING_DEFINITIONS.newSessionWizardColumnsEnabled.default).toBe(false);
    });

    it('defaults the new-session route presentation mode to auto', () => {
        expect(NEW_SESSION_PRESENTATION_MODES).toEqual(['auto', 'screen', 'modal']);
        expect(ACCOUNT_SETTING_DEFINITIONS.newSessionPresentationModeV1.default).toBe('auto');
        expect(ACCOUNT_SETTING_DEFINITIONS.newSessionPresentationModeV1.storageScope).toBe('account');
    });

    it('accepts only supported new-session route presentation modes', () => {
        const schema = ACCOUNT_SETTING_DEFINITIONS.newSessionPresentationModeV1.schema;

        expect(schema.parse('screen')).toBe('screen');
        expect(schema.parse('modal')).toBe('modal');
        expect(schema.parse('invalid')).toBe('auto');
    });

    it('stores remembered engine selections as account-scoped session creation settings', () => {
        expect(ACCOUNT_SETTING_DEFINITIONS.rememberLastEngineSelectionsV1.storageScope).toBe('account');
        expect(ACCOUNT_SETTING_DEFINITIONS.rememberLastEngineSelectionsV1.default).toBe(true);
        expect(ACCOUNT_SETTING_DEFINITIONS.lastEngineSelectionsByScopeV1.storageScope).toBe('account');
        expect(ACCOUNT_SETTING_DEFINITIONS.lastEngineSelectionsByScopeV1.default).toEqual({});
    });

    it('keeps valid wizard presentation overrides and drops unknown section or presentation values', () => {
        const schema = ACCOUNT_SETTING_DEFINITIONS.newSessionWizardSectionPresentationV1.schema;
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

    it('imports flat Oh My Pi selection and keeps the local setting structured', () => {
        const schema = LOCAL_ACCOUNT_SETTING_DEFINITIONS.lastUsedBackendTarget.schema;

        expect(schema.parse({
            kind: 'builtInAgent',
            agentId: 'ohMyPi',
        })).toEqual({
            kind: 'agent',
            identity: {
                pluginId: 'happier.agent.ohmypi',
                localId: 'ohmypi',
            },
        });
    });

    it('imports a predecessor Oh My Pi transcript-default key into the qualified identity', () => {
        const schema = ACCOUNT_SETTING_DEFINITIONS
            .newSessionDefaultPersistenceModeByTargetKeyV1.schema;

        expect(schema.parse({
            'agent:ohMyPi': 'direct',
        })).toEqual({
            'agent:happier.agent.ohmypi/ohmypi': 'direct',
        });
    });
});
