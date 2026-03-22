import { describe, expect, it } from 'vitest';
import { featureRequiresServerSnapshot, readServerEnabledBit } from '@happier-dev/protocol';

describe('features.tsx - embedded terminal dock location visibility', () => {
    it('terminal.embeddedPty requires server snapshot', () => {
        expect(featureRequiresServerSnapshot('terminal.embeddedPty')).toBe(true);
    });

    it('readServerEnabledBit returns false when terminal.embeddedPty is disabled by server', () => {
        const serverSnapshot = {
            features: {
                terminal: {
                    embeddedPty: {
                        enabled: false,
                    },
                },
            },
        };

        expect(readServerEnabledBit(serverSnapshot as any, 'terminal.embeddedPty')).toBe(false);
    });

    it('readServerEnabledBit returns true when terminal.embeddedPty is enabled by server', () => {
        const serverSnapshot = {
            features: {
                terminal: {
                    embeddedPty: {
                        enabled: true,
                    },
                },
            },
        };

        expect(readServerEnabledBit(serverSnapshot as any, 'terminal.embeddedPty')).toBe(true);
    });

    it('readServerEnabledBit returns null when terminal.embeddedPty is missing from server snapshot', () => {
        const serverSnapshot = {
            features: {
                terminal: {},
            },
        };

        expect(readServerEnabledBit(serverSnapshot as any, 'terminal.embeddedPty')).toBeNull();
    });
});
