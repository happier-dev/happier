import { describe, expect, expectTypeOf, it } from 'vitest';

import { PluginError } from '../errors.js';
import type { PluginDiagnosticData } from '../diagnostics.js';
import type { PluginServices } from '../services/index.js';
import {
    createPluginServiceReferenceAdapter,
} from './serviceAdapter.js';

function servicesWithAvailability(
    availability: PluginServices['availability'],
): Pick<PluginServices, 'availability'> {
    return { availability };
}

describe('plugin service reference adapter', () => {
    it('applies the same executable boundary to the exact stable service roster', async () => {
        const serviceIds = [
            'logger',
            'storage',
            'settings',
            'secrets',
            'events',
            'fetch',
            'fs',
            'exec',
            'managed',
            'sessions',
            'resources',
            'mcp',
            'notifications',
            'connectedAccounts',
        ] as const;
        expectTypeOf<typeof serviceIds[number]>().toEqualTypeOf<
            Parameters<PluginServices['availability']>[0]
        >();
        const observed: string[] = [];
        const adapter = createPluginServiceReferenceAdapter(
            servicesWithAvailability(() => ({ status: 'available' })),
        );

        for (const serviceId of serviceIds) {
            await adapter.invoke(serviceId, () => {
                observed.push(serviceId);
            });
        }

        expect(observed).toEqual(serviceIds);
    });

    it('executes an available operation and forwards its cancellation signal', async () => {
        const services = servicesWithAvailability(() => ({ status: 'available' }));
        const adapter = createPluginServiceReferenceAdapter(services);
        const controller = new AbortController();

        await expect(adapter.invoke('fetch', ({ signal }) => {
            expect(signal).toBe(controller.signal);
            return Promise.resolve('ok');
        }, { signal: controller.signal })).resolves.toBe('ok');
    });

    it.each(['unavailable', 'denied'] as const)(
        'rejects %s service access with one canonical PluginError and diagnostic',
        async (status) => {
            const diagnostics: PluginDiagnosticData[] = [];
            const services = servicesWithAvailability(() => ({
                status,
                code: `fixture_${status}`,
                remediation: { kind: 'retry' },
            }));
            const adapter = createPluginServiceReferenceAdapter(services, {
                onDiagnostic(diagnostic) {
                    diagnostics.push(diagnostic);
                },
            });
            let invoked = false;

            const failure = await adapter.invoke('secrets', () => {
                invoked = true;
            }).catch((error: unknown) => error);

            expect(invoked).toBe(false);
            expect(failure).toBeInstanceOf(PluginError);
            expect((failure as PluginError).data).toEqual({
                name: 'PluginError',
                code: `fixture_${status}`,
                retryable: false,
                details: { serviceId: 'secrets', availability: status },
                remediation: { kind: 'retry' },
                diagnostics: [{
                    code: `fixture_${status}`,
                    severity: status === 'denied' ? 'warning' : 'error',
                    details: { serviceId: 'secrets', availability: status },
                    remediation: { kind: 'retry' },
                }],
            });
            expect(diagnostics).toEqual((failure as PluginError).diagnostics);
        },
    );

    it('rejects an already-aborted invocation before author code runs', async () => {
        const services = servicesWithAvailability(() => ({ status: 'available' }));
        const adapter = createPluginServiceReferenceAdapter(services);
        const controller = new AbortController();
        controller.abort();
        let invoked = false;

        const failure = await adapter.invoke('events', () => {
            invoked = true;
        }, { signal: controller.signal }).catch((error: unknown) => error);

        expect(invoked).toBe(false);
        expect(failure).toBeInstanceOf(PluginError);
        expect((failure as PluginError).data).toMatchObject({
            code: 'plugin_operation_cancelled',
            retryable: false,
            details: { serviceId: 'events' },
        });
    });

    it('preserves canonical PluginError data and normalizes unknown failures', async () => {
        const services = servicesWithAvailability(() => ({ status: 'available' }));
        const adapter = createPluginServiceReferenceAdapter(services);
        const canonical = new PluginError({
            code: 'fixture_failure',
            retryable: true,
            details: { source: 'fixture' },
        });

        const preserved = await adapter.invoke('storage', () => {
            throw canonical;
        }).catch((error: unknown) => error);
        expect(preserved).toBe(canonical);

        const normalized = await adapter.invoke('storage', () => {
            throw new Error('private host detail');
        }).catch((error: unknown) => error);
        expect(normalized).toBeInstanceOf(PluginError);
        expect((normalized as PluginError).data).toEqual({
            name: 'PluginError',
            code: 'plugin_service_operation_failed',
            retryable: false,
            details: { serviceId: 'storage' },
            diagnostics: [{
                code: 'plugin_service_operation_failed',
                severity: 'error',
                details: { serviceId: 'storage' },
            }],
        });
    });

    it('joins disposal without consulting operation availability and normalizes cleanup failure', async () => {
        let availabilityCalls = 0;
        const services = servicesWithAvailability(() => {
            availabilityCalls += 1;
            return { status: 'denied', code: 'not_for_cleanup' };
        });
        const adapter = createPluginServiceReferenceAdapter(services);
        let disposed = false;

        await adapter.dispose('exec', {
            async dispose() {
                await Promise.resolve();
                disposed = true;
            },
        });

        expect(disposed).toBe(true);
        expect(availabilityCalls).toBe(0);

        const failure = await adapter.dispose('exec', {
            dispose() {
                throw new Error('private cleanup detail');
            },
        }).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(PluginError);
        expect((failure as PluginError).data).toMatchObject({
            code: 'plugin_service_disposal_failed',
            details: { serviceId: 'exec' },
        });
    });
});
