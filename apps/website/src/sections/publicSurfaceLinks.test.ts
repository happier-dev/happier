import { describe, expect, it } from 'vitest';

import { FOOTER_COLUMNS } from './Footer';
import { GET_STARTED_SECTION_ID } from './GetStarted';
import { SELF_HOST_SERVICES, SELF_HOST_TERMINAL_LINES } from './SelfHost';

describe('website public surface links', () => {
    it('keeps the footer get-started link aligned with the section anchor', () => {
        const productLinks = FOOTER_COLUMNS.find((column) => column.title === 'Product')?.links ?? [];

        expect(productLinks).toContainEqual(expect.objectContaining({
            label: 'Get started',
            href: `#${GET_STARTED_SECTION_ID}`,
        }));
    });

    it('links self-host users to the canonical deployment docs route', () => {
        const openSourceLinks = FOOTER_COLUMNS.find((column) => column.title === 'Open source')?.links ?? [];

        expect(openSourceLinks).toContainEqual(expect.objectContaining({
            label: 'Self-host',
            href: 'https://docs.happier.dev/deployment/self-host-runtime',
        }));
    });

    it('describes the managed Relay runtime without implying local daemon setup', () => {
        expect(SELF_HOST_TERMINAL_LINES.map((line) => line.text)).toContain('✓ Relay service started');
        expect(SELF_HOST_TERMINAL_LINES.map((line) => line.text)).not.toContain('✓ Daemon started');
        expect(SELF_HOST_SERVICES.map((service) => service.name)).toEqual([
            'Relay server',
            'Web UI',
            'Managed service',
        ]);
    });
});
