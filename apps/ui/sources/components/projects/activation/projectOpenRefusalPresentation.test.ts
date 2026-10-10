import { describe, expect, it } from 'vitest';
import { t } from '@/text';
import { projectOpenRefusalPresentation } from './projectOpenRefusalPresentation';

describe('Project Open refusal presentation', () => {
    it('offers target recovery without claiming the machine is offline or incapable', () => {
        expect(projectOpenRefusalPresentation('target_mismatch', null)).toEqual({
            title: t('projects.open.targetMismatch'), description: t('projects.open.targetMismatchHint'),
        });
    });
    it('retains distinct Source and transport refusals', () => {
        expect(projectOpenRefusalPresentation('source_changed', null)).toEqual({ title: t('projects.open.sourceChanged') });
        expect(projectOpenRefusalPresentation('machine_offline', null)).toEqual({ title: t('projects.open.accessLost') });
    });
});
