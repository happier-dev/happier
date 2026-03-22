import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { createServiceIpcContract } from './serviceIpcContract';
import {
    createServiceIpcMessageBuilder,
    decodeServiceIpcMessage,
    encodeServiceIpcMessage,
} from './serviceIpcMessages';

describe('serviceIpcMessages', () => {
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

    it('builds canonical parent/child IPC envelopes with the scoped service id', () => {
        const builder = createServiceIpcMessageBuilder(serviceContract);

        expect(builder.heartbeat({ sentAtMs: 10, sequence: 1 })).toEqual({
            service: 'test_worker',
            type: 'heartbeat',
            sentAtMs: 10,
            sequence: 1,
        });

        expect(
            builder.configUpdate({
                sentAtMs: 11,
                sequence: 2,
                configVersion: 3,
                config: {
                    watchMode: 'watch_poll',
                    intervalMs: 5000,
                },
            }),
        ).toEqual({
            service: 'test_worker',
            type: 'config_update',
            sentAtMs: 11,
            sequence: 2,
            configVersion: 3,
            config: {
                watchMode: 'watch_poll',
                intervalMs: 5000,
            },
        });

        expect(
            builder.statusUpdate({
                sentAtMs: 12,
                sequence: 3,
                statusVersion: 4,
                status: {
                    lifecycleState: 'running',
                    detail: 'healthy',
                },
            }),
        ).toEqual({
            service: 'test_worker',
            type: 'status_update',
            sentAtMs: 12,
            sequence: 3,
            statusVersion: 4,
            status: {
                lifecycleState: 'running',
                detail: 'healthy',
            },
        });
    });

    it('encodes validated service IPC messages as JSON', () => {
        expect(
            encodeServiceIpcMessage(
                serviceContract,
                serviceContract.ConfigUpdateMessageSchema.parse({
                    service: 'test_worker',
                    type: 'config_update',
                    sentAtMs: 21,
                    sequence: 8,
                    configVersion: 5,
                    config: {
                        watchMode: 'manual',
                        intervalMs: 1000,
                    },
                }),
            ),
        ).toBe(
            '{"service":"test_worker","sentAtMs":21,"sequence":8,"type":"config_update","configVersion":5,"config":{"watchMode":"manual","intervalMs":1000}}',
        );
    });

    it('decodes JSON payloads into validated service IPC messages', () => {
        expect(
            decodeServiceIpcMessage(
                serviceContract,
                '  {"service":"test_worker","type":"status_update","sentAtMs":42,"sequence":9,"statusVersion":7,"status":{"lifecycleState":"degraded","detail":"restarting"}}\n',
            ),
        ).toEqual({
            service: 'test_worker',
            type: 'status_update',
            sentAtMs: 42,
            sequence: 9,
            statusVersion: 7,
            status: {
                lifecycleState: 'degraded',
                detail: 'restarting',
            },
        });
    });

    it('rejects malformed or out-of-contract encoded payloads', () => {
        expect(() => decodeServiceIpcMessage(serviceContract, '{')).toThrow();

        expect(() =>
            decodeServiceIpcMessage(
                serviceContract,
                '{"service":"other_worker","type":"heartbeat","sentAtMs":1,"sequence":1}',
            ),
        ).toThrow();
    });
});
