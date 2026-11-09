import { describe, expect, it } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import { createUnavailablePluginServices } from './unavailable';

describe('unavailable invocation services', () => {
    it('refuses Provider usage refresh with the typed unavailable service result', () => {
        const services = createUnavailablePluginServices();
        expect(() => services.providers.usage.refresh({
            connectionId: ProviderConnectionIdSchema.parse('pc_unavailable'),
        })).toThrow(expect.objectContaining({
            code: 'plugin_service_unavailable', details: { serviceId: 'providers' },
        }));
    });

    it('refuses native socket preparation through the typed unavailable Exec contract', () => {
        const services = createUnavailablePluginServices();
        expect(() => services.exec.prepareNativeSocketDirectory()).toThrow(expect.objectContaining({
            code: 'plugin_service_unavailable', details: { serviceId: 'exec' },
        }));
    });

    it('keeps the actual host placement reason in a typed unavailable result', () => {
        const services = createUnavailablePluginServices({
            unavailableDiagnostics: { sessions: { requiredInvocationPlacement: 'daemon' } },
        });
        expect(() => services.sessions.list()).toThrow(expect.objectContaining({
            code: 'plugin_service_unavailable',
            details: { serviceId: 'sessions', requiredInvocationPlacement: 'daemon' },
        }));
    });

    it('returns typed unavailability through filesystem operations', () => {
        const services = createUnavailablePluginServices();
        const path = { root: 'workspace' as const, relativePath: '' };
        expect(services.availability('fs')).toEqual({ status: 'unavailable', code: 'plugin_service_unavailable' });
        for (const operation of [
            () => services.fs.readFile(path),
            () => services.fs.writeFile(path, new Uint8Array()),
            () => services.fs.stat(path),
            () => services.fs.list(path),
            () => services.fs.remove(path),
        ]) expect(operation).toThrow(expect.objectContaining({
            code: 'plugin_service_unavailable', details: { serviceId: 'fs' },
        }));
    });
});
