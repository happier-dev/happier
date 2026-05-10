import { describe, expect, it } from 'vitest';

import { buildNewSessionScreenVariantModel } from './buildNewSessionScreenVariantModel';

describe('buildNewSessionScreenVariantModel', () => {
    it('preserves wizard section presentation and column settings in wizard props', () => {
        const sectionPresentation = {
            machines: 'dropdown',
            paths: 'dropdown',
        } as const;

        const model = buildNewSessionScreenVariantModel({
            useEnhancedSessionWizard: true,
            popoverBoundaryRef: { current: null },
            simplePanelProps: {},
            checkoutCreationDraft: null,
            setCheckoutCreationDraft: () => {},
            wizardLayoutProps: {},
            wizardSectionPresentation: sectionPresentation,
            wizardUseColumnLayout: true,
            wizardProfilesProps: {},
            wizardAgentProps: {},
            wizardMachineProps: {},
            wizardFooterProps: {},
        } as any);

        expect(model.variant).toBe('wizard');
        if (model.variant !== 'wizard') return;
        expect(model.wizardProps.sectionPresentation).toBe(sectionPresentation);
        expect(model.wizardProps.useColumnLayout).toBe(true);
    });
});
