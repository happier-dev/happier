import { describe, expect, it } from 'vitest';

import { readEligibleEventPresentation } from './pluginEventAutomationEventPresentation';

const event = (presentation?: Readonly<{ title: unknown; description?: unknown }>) => ({
    event: {
        identity: { pluginId: 'happier.machine.services', localId: 'deployment-failed' },
        title: 'Deployment failed',
        description: 'A deployment stopped before it finished.',
        ...(presentation ? { localizedPresentation: presentation } : {}),
    },
}) as never;

describe('readEligibleEventPresentation', () => {
    it('resolves the catalog localized descriptors through the plugin resolver', () => {
        const localize = (pluginId: string, value: unknown) => `${pluginId}:${(value as { key: string }).key}`;
        expect(readEligibleEventPresentation(event({
            title: { key: 'machineServices.events.deploymentFailed.title', fallback: 'Deployment failed' },
            description: { key: 'machineServices.events.deploymentFailed.description', fallback: 'x' },
        }), localize)).toEqual({
            title: 'happier.machine.services:machineServices.events.deploymentFailed.title',
            description: 'happier.machine.services:machineServices.events.deploymentFailed.description',
        });
    });

    it('keeps the declared strings when the catalog carries no localized descriptors', () => {
        expect(readEligibleEventPresentation(event(), () => 'unused')).toEqual({
            title: 'Deployment failed',
            description: 'A deployment stopped before it finished.',
        });
    });

    it('keeps the declared description when only the title is localized', () => {
        expect(readEligibleEventPresentation(event({ title: { key: 'k', fallback: 'f' } }), () => 'Échec du déploiement')).toEqual({
            title: 'Échec du déploiement',
            description: 'A deployment stopped before it finished.',
        });
    });
});
