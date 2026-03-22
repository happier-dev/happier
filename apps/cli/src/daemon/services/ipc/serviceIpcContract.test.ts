import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import {
    SERVICE_IPC_MESSAGE_TYPES,
    createServiceIpcContract,
} from './serviceIpcContract';

describe('serviceIpcContract', () => {
    const serviceContract = createServiceIpcContract({
        service: 'test_worker',
        configSchema: z
            .object({
                watchMode: z.enum(['manual', 'watch_poll']),
                intervalMs: z.number().int().positive(),
            })
            .strict(),
        statusSchema: z
            .object({
                lifecycleState: z.enum(['starting', 'running', 'degraded']),
                detail: z.string().min(1).optional(),
            })
            .strict(),
    });

    it('exposes the canonical foundational IPC message kinds', () => {
        expect(SERVICE_IPC_MESSAGE_TYPES).toEqual(['heartbeat', 'config_update', 'status_update']);
    });

    it('creates a typed heartbeat schema scoped to one service', () => {
        expect(
            serviceContract.HeartbeatMessageSchema.parse({
                service: 'test_worker',
                type: 'heartbeat',
                sentAtMs: 10,
                sequence: 2,
            }),
        ).toEqual({
            service: 'test_worker',
            type: 'heartbeat',
            sentAtMs: 10,
            sequence: 2,
        });

        expect(
            serviceContract.HeartbeatMessageSchema.safeParse({
                service: 'other_worker',
                type: 'heartbeat',
                sentAtMs: 10,
                sequence: 2,
            }).success,
        ).toBe(false);
    });

    it('wraps config and status payloads with versioned update envelopes', () => {
        expect(
            serviceContract.ConfigUpdateMessageSchema.parse({
                service: 'test_worker',
                type: 'config_update',
                sentAtMs: 11,
                sequence: 3,
                configVersion: 4,
                config: {
                    watchMode: 'watch_poll',
                    intervalMs: 5000,
                },
            }),
        ).toEqual({
            service: 'test_worker',
            type: 'config_update',
            sentAtMs: 11,
            sequence: 3,
            configVersion: 4,
            config: {
                watchMode: 'watch_poll',
                intervalMs: 5000,
            },
        });

        expect(
            serviceContract.StatusUpdateMessageSchema.parse({
                service: 'test_worker',
                type: 'status_update',
                sentAtMs: 12,
                sequence: 4,
                statusVersion: 5,
                status: {
                    lifecycleState: 'running',
                    detail: 'healthy',
                },
            }),
        ).toEqual({
            service: 'test_worker',
            type: 'status_update',
            sentAtMs: 12,
            sequence: 4,
            statusVersion: 5,
            status: {
                lifecycleState: 'running',
                detail: 'healthy',
            },
        });
    });

    it('builds one discriminated union parser for future service-worker message streams', () => {
        expect(
            serviceContract.ServiceMessageSchema.parse({
                service: 'test_worker',
                type: 'status_update',
                sentAtMs: 99,
                sequence: 6,
                statusVersion: 7,
                status: {
                    lifecycleState: 'degraded',
                    detail: 'waiting for reconnect',
                },
            }),
        ).toEqual({
            service: 'test_worker',
            type: 'status_update',
            sentAtMs: 99,
            sequence: 6,
            statusVersion: 7,
            status: {
                lifecycleState: 'degraded',
                detail: 'waiting for reconnect',
            },
        });
    });

    it('keeps the foundational schemas strict for unexpected fields', () => {
        expect(
            serviceContract.ConfigUpdateMessageSchema.safeParse({
                service: 'test_worker',
                type: 'config_update',
                sentAtMs: 11,
                sequence: 3,
                configVersion: 4,
                config: {
                    watchMode: 'manual',
                    intervalMs: 1000,
                },
                unexpected: true,
            }).success,
        ).toBe(false);

        expect(
            serviceContract.StatusUpdateMessageSchema.safeParse({
                service: 'test_worker',
                type: 'status_update',
                sentAtMs: 12,
                sequence: 4,
                statusVersion: 5,
                status: {
                    lifecycleState: 'running',
                    detail: 'healthy',
                    unexpected: true,
                },
            }).success,
        ).toBe(false);
    });
});
