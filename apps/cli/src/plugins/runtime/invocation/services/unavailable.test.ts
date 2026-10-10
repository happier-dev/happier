import { describe, expect, it } from 'vitest';

import {
    createUnavailablePluginServices,
    createPluginInvocationServiceBinding,
    withPluginInvocationServiceBindingAvailability,
    PLUGIN_SERVICE_HOST_ACCESS_DECLARATION_MISSING_CODE,
} from './unavailable';

describe('unavailable invocation services', () => {
    it('reuses unchanged invocation availability without the CPU cost of rebinding services', () => {
        const unavailable = createPluginInvocationServiceBinding('occurrence', 'invocation');
        const available = withPluginInvocationServiceBindingAvailability(unavailable,
            { serviceId: 'fs', availability: 'available' });
        expect(available).not.toBe(unavailable);
        expect(available.availability.fs).toBe('available');
        expect(unavailable.availability.fs).toBe('unavailable');
        expect(Object.isFrozen(available.availability)).toBe(true);

        const measure = (availability: 'available' | 'unavailable') => {
            const started = process.cpuUsage();
            let result = unavailable;
            for (let iteration = 0; iteration < 20_000; iteration += 1) {
                result = withPluginInvocationServiceBindingAvailability(unavailable,
                    { serviceId: 'fs', availability },
                    { serviceId: 'sessions', availability: 'unavailable' });
            }
            const cpu = process.cpuUsage(started);
            return { cpuUs: cpu.user + cpu.system, result };
        };
        measure('available');
        measure('unavailable');
        const unchanged = measure('unavailable');
        const changed = measure('available');
        console.info(JSON.stringify({ unchangedCpuUs: unchanged.cpuUs, changedCpuUs: changed.cpuUs }));
        expect(unchanged.result).toBe(unavailable);
        expect(changed.result.availability.fs).toBe('available');
        expect(unchanged.cpuUs).toBeLessThan(changed.cpuUs / 2);
        const lastWins = withPluginInvocationServiceBindingAvailability(available,
            { serviceId: 'fs', availability: 'available' },
            { serviceId: 'fs', availability: 'denied' });
        expect(lastWins.availability.fs).toBe('denied');
        expect(available.availability.fs).toBe('available');
    });

    it('projects the exact manifest HostAccess remediation through the canonical service descriptor', async () => {
        const services = createUnavailablePluginServices({
            unavailableDiagnostics: {
                mcp: {
                    code: PLUGIN_SERVICE_HOST_ACCESS_DECLARATION_MISSING_CODE,
                    requiredHostAccessCapability: 'mcp',
                },
            },
        });

        expect(services.availability('mcp')).toEqual({
            status: 'unavailable',
            code: PLUGIN_SERVICE_HOST_ACCESS_DECLARATION_MISSING_CODE,
        });
        await expect(services.mcp.list()).rejects.toMatchObject({
            code: PLUGIN_SERVICE_HOST_ACCESS_DECLARATION_MISSING_CODE,
            message: "Plugin service 'mcp' requires a manifest hostAccess declaration for 'mcp'",
            details: {
                serviceId: 'mcp',
                requiredHostAccessCapability: 'mcp',
            },
        });
    });

    it('names the required invocation placement when it is the known missing fact', async () => {
        const services = createUnavailablePluginServices({
            unavailableDiagnostics: {
                sessions: { requiredInvocationPlacement: 'daemon' },
            },
        });

        expect(() => services.sessions.list()).toThrow(expect.objectContaining({
            code: 'plugin_service_unavailable',
            message: "Plugin service 'sessions' requires a daemon invocation host",
            details: {
                serviceId: 'sessions',
                requiredInvocationPlacement: 'daemon',
            },
        }));
    });

    it('identifies a declared but currently unavailable filesystem capability on every fs method', async () => {
        const diagnostic = {
            unavailableHostAccessCapability: 'filesystem',
        };
        const services = createUnavailablePluginServices({
            unavailableDiagnostics: { fs: diagnostic },
        });
        const path = { root: 'workspace' as const, relativePath: '' };
        const operations = [
            () => services.fs.readFile(path),
            () => services.fs.writeFile(path, new Uint8Array()),
            () => services.fs.stat(path),
            () => services.fs.list(path),
            () => services.fs.remove(path),
        ];

        expect(services.availability('fs')).toEqual({
            status: 'unavailable',
            code: 'plugin_service_unavailable',
        });
        for (const operation of operations) {
            expect(operation).toThrow(expect.objectContaining({
                code: 'plugin_service_unavailable',
                message: "Plugin service 'fs' declares hostAccess capability 'filesystem', but it is unavailable in the current invocation host",
                details: {
                    serviceId: 'fs',
                    unavailableHostAccessCapability: 'filesystem',
                },
            }));
        }
    });
});
